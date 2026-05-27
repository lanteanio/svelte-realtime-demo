/**
 * /demos/pressure - live admission-shedding control panel.
 *
 * The pitch: the destroyer test (e2e/destroyer-standalone.js) ramps
 * 10K connections to find the ceiling. With Phase 3.1's two-tier
 * admission control wired, the server sheds cleanly long before it
 * falls over. This page makes that visible: a live readout of
 * `platform.pressure`, an in-page load generator, and a list of
 * recent shed decisions.
 *
 * Streams:
 * - `demos:pressure:tick` - 500ms heartbeat publishing the current
 *   pressure snapshot. `merge: 'set'`. Self-arms on first subscribe
 *   the same way /demos/counter-resume did originally (no static
 *   import of live modules from hooks.ws.js). Leader-gated inside
 *   the timer body so only one replica publishes the snapshot per
 *   tick - without the gate, two replicas would each publish their
 *   own snapshot to the same global topic at 2 Hz and subscribers
 *   would see jumpy values alternating between two workers' views.
 * - `demos:pressure:shed` - crud merge of recent shed decisions, also
 *   cluster-shared (Redis LIST) so a shed event recorded on any
 *   replica is visible to subscribers on every replica via the
 *   loader and via cluster pub/sub.
 *
 * RPCs:
 * - `generateLoad(count)` - publishes `count` no-op events to
 *   `demos:pressure:noise` (capped at 5000 to keep the demo from
 *   self-DOSing). Checks `ctx.shed('background')` after; if shed,
 *   publishes a real shed event with the actual pressure reason.
 * - `simulateShed()` - always publishes a synthetic shed event,
 *   regardless of actual pressure. Lets the page demonstrate the
 *   surface even when the demo's load isn't enough to drive
 *   PUBLISH_RATE past the admission threshold.
 *
 * Note on `live.cron` vs leader-gated setInterval: live.cron caps at
 * 1 Hz, but the pressure snapshot's natural cadence is 500ms (so the
 * page's sparkline doesn't lag a full second behind real load). The
 * leader-gated setInterval lets us keep sub-second timing while still
 * being a cluster-singleton publisher.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis, leader } from '$lib/server/redis'

const TICK_INTERVAL_MS = 500
const SHED_MAX = 50
const LOAD_CAP = 5000

const LAST_SNAPSHOT_KEY = 'demos:pressure:last-snapshot'
const SHED_KEY = 'demos:pressure:shed'

let armed = false

/**
 * Boot-time arm of the per-worker snapshot ticker. Called once per worker
 * from `hooks.ws.js`'s `init({ platform })` so every replica has its
 * snapshot interval running before the first subscriber connects. The
 * leader gate inside the timer body still ensures only the cluster
 * leader actually publishes a snapshot per tick -- the other replicas
 * just hit the early-return path on every fire (a single conditional
 * check; tiny CPU).
 *
 * Pre-fix, this was only invoked from the stream loader on first
 * subscribe. With 4 replicas behind SO_REUSEPORT, a subscribe connection
 * lands on whichever replica the kernel routes it to (uniform); only
 * the leader's interval body actually publishes. If the leader hadn't
 * yet had a subscriber, its ticker was never armed, the snapshot was
 * never written to Redis, and the loader returned null forever -- the
 * client's `if (!v) return` guard then silently skipped every emission
 * and the page's `reason` badge stayed at `...`. Symptom: pressure
 * stream is dead after every deploy until a subscriber happens to land
 * on the leader replica (~25% chance per fresh WS on a 4-replica
 * cluster). Boot-arm closes the race deterministically.
 *
 * @param {*} platform - the cluster-aware platform reference captured
 *   in `init({ platform })`.
 */
export function armPressureTicker(platform) {
	if (armed) return
	armed = true
	setInterval(async () => {
		// Leader-gated: every replica fires the timer (Node's setInterval
		// is per-process) but only the leader computes and publishes a
		// snapshot. Without the gate, N replicas would each publish their
		// own snapshot to the same global topic, producing jumpy values.
		if (!leader.isLeader()) return
		// Snapshot getter returns a fresh object each call; safe to
		// publish directly. Ignore topPublishers in the demo wire
		// shape - the readout only needs the scalar fields. Heap
		// usage is sampled independently here because the adapter's
		// pressure snapshot only exposes `memoryMB` (RSS), and the
		// MEMORY reason is computed from `heapUsed / heapTotal` -
		// surfacing both lets the page explain WHY MEMORY fires.
		const snap = platform.pressure
		const mem = process.memoryUsage()
		const heapTotalMB = mem.heapTotal / (1024 * 1024)
		const heapUsedMB = mem.heapUsed / (1024 * 1024)
		const heapPct = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0
		const payload = {
			active: !!snap.active,
			subscriberRatio: snap.subscriberRatio ?? 0,
			publishRate: snap.publishRate ?? 0,
			memoryMB: snap.memoryMB ?? 0,
			heapUsedMB,
			heapTotalMB,
			heapPct,
			reason: snap.reason ?? 'NONE',
			ts: Date.now(),
			instanceId: leader.instanceId
		}
		// Persist for new subscribers' loader; publish for live ones.
		// SET with a short TTL so a leadership flip followed by silence
		// doesn't leave a stale snapshot at the top of the page forever.
		try { await redis.redis.set(LAST_SNAPSHOT_KEY, JSON.stringify(payload), 'EX', 30) } catch {}
		platform.publish(TOPICS.demoPressureTick, 'set', payload)
	}, TICK_INTERVAL_MS)
}

export const pressureSnapshot = live.stream(
	TOPICS.demoPressureTick,
	async () => {
		// The ticker is armed once per worker at boot from hooks.ws.js's
		// init({ platform }) so the leader is always publishing snapshots
		// regardless of which replica a subscriber lands on. New
		// subscribers' loaders read the latest snapshot from Redis (set
		// by the leader's interval body with a 30s TTL).
		const raw = await redis.redis.get(LAST_SNAPSHOT_KEY)
		if (!raw) return null
		try { return JSON.parse(raw) } catch { return null }
	},
	{ merge: 'set' }
)

export const shedEvents = live.stream(
	TOPICS.demoPressureShed,
	async () => {
		const raws = await redis.redis.lrange(SHED_KEY, 0, -1)
		const out = []
		for (const raw of raws) {
			try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
		}
		return out
	},
	{ merge: 'crud', key: 'id' }
)

/**
 * Cluster-shared shed log. LPUSH puts newest first; LTRIM bounds the
 * list at SHED_MAX. The LRANGE between captures any entries the LTRIM
 * is about to drop so subscribers see a 'deleted' event for each.
 */
async function pushShed(ctx, entry) {
	const raw = JSON.stringify(entry)
	const pipeline = redis.redis.multi()
	pipeline.lpush(SHED_KEY, raw)
	pipeline.lrange(SHED_KEY, SHED_MAX, -1)
	pipeline.ltrim(SHED_KEY, 0, SHED_MAX - 1)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(TOPICS.demoPressureShed, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already evicted */ }
	}
	ctx.publish(TOPICS.demoPressureShed, 'created', entry)
}

/**
 * Spread the burst over ~1.5 seconds in 100ms chunks. The adapter's
 * pressure sampler runs at 1 Hz; a single-tick `publishBatched(5000)`
 * spikes `publishCountWindow` to 5000 then resets at the next sample,
 * giving the snapshot publisher one 500ms tick where it could observe
 * the spike - easy to miss on a sparkline. Spreading turns the burst
 * into a sustained rate of `count / 1.5` per second across ~15 chunks,
 * which the sampler reads as the steady rate for the whole window.
 *
 * The `ctx.shed` check fires AFTER the final chunk so it observes the
 * peak rate the burst drove the platform to. A real shed (reason
 * surfaces from the pressure snapshot's `reason` field) appends to the
 * log; a same-tick recovery is normal because the burst stops.
 */
export const generateLoad = live(async (ctx, count) => {
	const safe = Math.min(Math.max(parseInt(count) || 100, 1), LOAD_CAP)

	// Small bursts (<=200) fire in a single tick so the +100 button
	// stays snappy. Larger bursts spread over ~1.5s in 100ms chunks
	// so the adapter's 1Hz pressure sampler observes a sustained rate
	// across multiple sample windows instead of a microsecond spike
	// that decays before the snapshot publisher's next 500ms tick.
	const SMALL_THRESHOLD = 200
	const SPREAD_MS = 1500
	const CHUNK_MS = 100

	function buildChunk(start, n) {
		const messages = new Array(n)
		for (let i = 0; i < n; i++) {
			messages[i] = {
				topic: TOPICS.demoPressureNoise,
				event: 'tick',
				data: { i: start + i, ts: Date.now() }
			}
		}
		return messages
	}

	let sent = 0
	if (safe <= SMALL_THRESHOLD) {
		ctx.platform.publishBatched(buildChunk(0, safe))
		sent = safe
	} else {
		const chunks = Math.max(1, Math.round(SPREAD_MS / CHUNK_MS))
		const perChunk = Math.ceil(safe / chunks)
		for (let c = 0; c < chunks && sent < safe; c++) {
			const n = Math.min(perChunk, safe - sent)
			ctx.platform.publishBatched(buildChunk(sent, n))
			sent += n
			if (c < chunks - 1 && sent < safe) {
				await new Promise((resolve) => setTimeout(resolve, CHUNK_MS))
			}
		}
	}

	// Check pressure AFTER the final chunk so the shed observation
	// reflects the peak the burst drove the platform to.
	if (ctx.shed('background')) {
		const snap = ctx.platform.pressure
		await pushShed(ctx, {
			id: crypto.randomUUID(),
			ts: Date.now(),
			class: 'background',
			handler: 'generateLoad',
			reason: snap.reason,
			source: 'real'
		})
	}
	return { generated: sent }
})

export const simulateShed = live(async (ctx) => {
	await pushShed(ctx, {
		id: crypto.randomUUID(),
		ts: Date.now(),
		class: 'background',
		handler: 'simulateShed',
		reason: 'PUBLISH_RATE',
		source: 'simulated'
	})
	return { ok: true }
})

export const clearShedLog = live(async (ctx) => {
	const raws = await redis.redis.lrange(SHED_KEY, 0, -1)
	await redis.redis.del(SHED_KEY)
	for (const raw of raws) {
		try {
			const e = JSON.parse(raw)
			ctx.publish(TOPICS.demoPressureShed, 'deleted', e)
		} catch { /* corrupt entry already gone */ }
	}
	return { cleared: raws.length }
})
