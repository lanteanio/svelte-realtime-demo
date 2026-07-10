// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/cluster-cron - Redis-backed leader election visualised end-to-end.
 *
 * The pitch: run two prod servers against the same Redis. Both register
 * the same 1Hz live.cron, but `live.configureCron({ leader })` (wired in
 * src/hooks.ws.js init) gates each tick on the cluster-wide lease. Only
 * the leader fires; the non-leader skips with a `cron{status:'not-leader'}`
 * metric increment. Stop the leader's process (Ctrl-C); the lease
 * expires within `renewMs` (10s); a sibling acquires it; the page
 * reflects the takeover with a fresh stream of ticks tagged with the
 * new leader's instanceId.
 *
 * Three primitives showcased:
 *
 *  - createLeader(redis, options?) - extensions . The Redis-
 *    lease primitive that elects exactly one worker across the cluster.
 *    `leader.isLeader()` is a microsecond-cost cached boolean check
 *    suitable for calling at the top of every cron tick. Wired once
 *    in src/lib/server/redis.js; this demo just consumes the export.
 *
 *  - live.configureCron({ leader }) - realtime wiring that gates every
 *    cron schedule in the app on the leader getter. Single-instance
 *    dev: this worker is always the leader so behaviour is identical
 *    to no-leader-config. Multi-worker: only the leader fires; a
 *    `leader_acquired_total{key_class}` counter on /metrics exposes
 *    transitions for ops dashboards.
 *
 *  - live.cron('* * * * * *', ...) - the cron registration itself.
 *    Identical shape to the firehose ticks in /demos/topk and
 *    /demos/news; the only thing that makes this one a cluster
 *    primitive is the leader gate around it.
 *
 * Storage is cluster-shared via Redis (LIST + counter). Only the leader
 * writes per tick, but every replica reads via the loader and via live
 * cluster pub/sub fan-out, so a subscriber on a non-leader replica gets
 * the same view as a subscriber on the leader. Recent ticks are capped
 * at TICK_CAP entries with FIFO eviction via LTRIM.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { leader, redis } from '$lib/server/redis'

const TICK_CAP = 30

const TICKS_KEY = 'demos:cluster-cron:ticks'
const TICK_COUNT_KEY = 'demos:cluster-cron:count'

async function readTickCount() {
	const v = await redis.redis.get(TICK_COUNT_KEY)
	if (v === null) return 0
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

async function readRecentTicks() {
	const raws = await redis.redis.lrange(TICKS_KEY, 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

/**
 * Page-load probe. Returns this instance's identity, its current leader
 * status, and the cluster-shared recent-ticks snapshot. The page renders
 * without a flash of empty state on first mount even if zero ticks have
 * fired yet (e.g. a fresh boot with no Redis lease yet acquired).
 *
 * The clusterTicks stream is the source of truth thereafter; this RPC
 * just primes the panel. `instanceId` and `isLeader()` are necessarily
 * per-replica - the demo's point is to show WHICH worker holds the lease
 * right now - so they are not cluster-shared.
 */
export const myClusterCronState = live(async () => {
	const [tickCount, ticks] = await Promise.all([readTickCount(), readRecentTicks()])
	return {
		instanceId: leader.instanceId,
		leaseKey: leader.key,
		isLeader: leader.isLeader(),
		tickCap: TICK_CAP,
		tickCount,
		ticks
	}
})

/**
 * Live stream of recent ticks. Capped at TICK_CAP with FIFO eviction
 * inside the cron tick. Reads from Redis so every replica returns the
 * same view.
 */
export const clusterTicks = live.stream(
	TOPICS.demoClusterCronTick,
	async () => readRecentTicks(),
	{ merge: 'crud', key: 'id' }
)

/**
 * 1Hz tick. Gated by configureCron({ leader }) cluster-wide so only one
 * instance fires per second. Each fire publishes `{ id, instanceId, ts }`
 * onto the stream topic; the page renders the recent-tick log and uses
 * the latest entry's instanceId to highlight which worker is currently
 * the leader.
 *
 * INCR + RPUSH are atomic across replicas, so a leader handover (lease
 * expiry on the old leader, acquisition by a sibling) produces a
 * continuous sequence rather than rebasing the count to zero. Eviction
 * via LTRIM bounds the list at TICK_CAP and publishes 'deleted' for
 * each evicted entry so subscribers' crud merges drop them.
 *
 * Single-flight; cluster-singleton via configureCron({ leader }) wired
 * in src/hooks.ws.js init.
 */
export const cronTick = live.cron('* * * * * *', TOPICS.demoClusterCronTick, async (ctx) => {
	const tickCount = await redis.redis.incr(TICK_COUNT_KEY)
	const entry = {
		id: crypto.randomUUID(),
		instanceId: leader.instanceId,
		ts: Date.now(),
		seq: tickCount
	}
	const raw = JSON.stringify(entry)
	// RPUSH adds at the end (newest last); LRANGE 0 -(TICK_CAP+1)
	// captures the front entries that the subsequent LTRIM -TICK_CAP -1
	// will drop. When length <= TICK_CAP the LRANGE returns empty and
	// the LTRIM is a no-op.
	const pipeline = redis.redis.multi()
	pipeline.rpush(TICKS_KEY, raw)
	pipeline.lrange(TICKS_KEY, 0, -(TICK_CAP + 1))
	pipeline.ltrim(TICKS_KEY, -TICK_CAP, -1)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(TOPICS.demoClusterCronTick, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already evicted */ }
	}
	ctx.publish(TOPICS.demoClusterCronTick, 'created', entry)
})
