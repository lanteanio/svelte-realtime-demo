// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/alarms - durable one-shot timers (live.alarm).
 *
 * The pitch: schedule a reminder two minutes out, then kill the worker
 * (or redeploy). The alarm still fires - exactly once across the whole
 * cluster - and the fired record tells you HOW it fired: `recovered:
 * true` means the restart ate the precise in-memory timer and the
 * leader's recovery poll swept the durable row instead; `lateMs` says
 * how far past the deadline the handler actually ran.
 *
 * Mechanism: the `timers` stream declares `{ alarm: { onAlarm } }`, so
 * the framework binds `ctx.setAlarm` / `ctx.getAlarm` /
 * `ctx.deleteAlarm` for this room whenever the loader runs. Durability
 * + cluster single-fire come from the app-wide `configureAlarm({
 * store, leader })` wiring in src/hooks.ws.js: the Redis alarm store
 * survives worker restarts, and the atomic store delete is the claim
 * that guarantees the precise timer and the recovery poll never both
 * fire the same alarm.
 *
 * Arming pattern: `ctx.setAlarm` lives on the STREAM's ctx (it is
 * bound on the subscribe path), not on a bare `live()` RPC ctx - the
 * loader is this room's single alarm writer. The schedule / cancel
 * RPCs therefore record intent in Redis and publish a nudge on a
 * control topic the stream watches via `invalidateOn`; the framework
 * re-runs the loader (with the room ctx), and the loader syncs the
 * framework alarm to the recorded intent. Redis is the source of
 * truth, the loader is the reconciler - a fresh subscriber arms the
 * same pending alarm idempotently (`setAlarm` replaces, one pending
 * alarm per room), and a stale intent from a dead run self-heals as a
 * fire-ASAP alarm on the next subscribe.
 *
 * No `misfireMs` is set: fire-when-late is the right policy for
 * reminders (a delayed reminder is still useful). An auction close
 * would set a threshold so stale fires are skipped instead.
 *
 * The fired log is a Redis list so it is cluster-shared and survives
 * restarts alongside the alarm rows. Records hold only framework
 * timestamps - no user content, no PII.
 *
 * Retention is BOTH a count and an age. The cap alone bounded the list
 * at twenty entries and nothing ever aged out: with light traffic a
 * record from days ago sat in "Fired alarms" indefinitely, reading as
 * staleness in a realtime demo. Fired records now leave after
 * RETENTION_MS: the loader prunes aged entries on every run (they are
 * removed by VALUE, not by index, so a concurrent fire pushing a new
 * head cannot shift a live entry under the trim), and both Redis keys
 * carry TTLs so an abandoned demo drains to nothing on its own - which
 * is also what makes the purge module's "TTL'd Redis keys" exclusion
 * true for this demo rather than aspirational.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'
import { partitionFired, RETENTION_MS } from '$lib/server/alarm-retention'

const LOG_KEY = 'demos:alarms:fired'
const PENDING_KEY = 'demos:alarms:pending'
const LOG_CAP = 20
const MIN_SECONDS = 2
const MAX_SECONDS = 600

/**
 * Read the fired-alarm log, newest first (LPUSH order), pruning entries
 * past RETENTION_MS as a side effect. Aged entries are removed by VALUE
 * (LREM) rather than by trimming to an index: an alarm firing between
 * the read and the trim pushes a new head, and an index-based trim
 * computed from the stale read would cut that live record off instead
 * of the aged tail. Corrupt entries are removed the same way. Each
 * removal is published as 'deleted' so already-subscribed tabs converge
 * without waiting for their next loader run; the CRUD merge makes a
 * duplicate 'deleted' from two concurrent loaders a no-op.
 * @param {(event: string, data: any) => void} [publish]
 */
async function readLog(publish) {
	const raws = await redis.redis.lrange(LOG_KEY, 0, -1)
	const records = []
	const corrupt = []
	for (const raw of raws) {
		try { records.push({ entry: JSON.parse(raw), raw }) } catch { corrupt.push(raw) }
	}
	const { fresh, stale } = partitionFired(records, Date.now())
	if (stale.length > 0 || corrupt.length > 0) {
		const removal = redis.redis.multi()
		for (const record of stale) removal.lrem(LOG_KEY, 1, record.raw)
		for (const raw of corrupt) removal.lrem(LOG_KEY, 1, raw)
		removal.pexpire(LOG_KEY, RETENTION_MS)
		await removal.exec()
		if (publish) {
			for (const record of stale) {
				if (typeof record.entry?.id === 'string') publish('deleted', { id: record.entry.id })
			}
		}
	}
	return fresh.slice(0, LOG_CAP).map((record) => record.entry)
}

/** Read the pending-alarm intent, or null when none is recorded. */
async function readPending() {
	const raw = await redis.redis.get(PENDING_KEY)
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		return typeof parsed?.at === 'number' && Number.isFinite(parsed.at) ? parsed : null
	} catch {
		return null
	}
}

/**
 * The alarm room. The loader returns the fired log AND reconciles the
 * framework alarm to the Redis intent: pending -> setAlarm(at) (replace
 * semantics make re-arming from every subscriber idempotent), no
 * pending -> deleteAlarm(). `invalidateOn` on the control topic re-runs the
 * loader whenever schedule / cancel publish their nudge, so the
 * reconcile happens within one round-trip of the click.
 *
 * onAlarm runs with a fresh ws-less server ctx even if every tab is
 * closed. It appends the fired record to the Redis log, clears the
 * intent key, and publishes 'created' into this room so open tabs see
 * the record land live.
 */
export const timers = live.stream(TOPICS.demoAlarmsLog, async (ctx) => {
	try {
		const pending = await readPending()
		if (pending) ctx.setAlarm(pending.at)
		else ctx.deleteAlarm()
	} catch {
		// ctx.setAlarm is bound on the wire-subscribe path; a loader run
		// reached another way (or a Redis blip) leaves the alarm as-is.
	}
	return readLog((event, data) => ctx.publish(event, data))
}, {
	merge: 'crud',
	key: 'id',
	invalidateOn: TOPICS.demoAlarmsControl,
	alarm: {
		onAlarm: async (ctx) => {
			const record = {
				id: crypto.randomUUID(),
				at: ctx.alarm.at,
				firedAt: ctx.alarm.firedAt,
				lateMs: ctx.alarm.lateMs,
				recovered: ctx.alarm.recovered
			}
			await redis.redis.multi()
				.lpush(LOG_KEY, JSON.stringify(record))
				.ltrim(LOG_KEY, 0, LOG_CAP - 1)
				// The whole-key TTL, refreshed per fire: age-pruning happens on
				// read, and this is what drains the key to nothing when nobody
				// fires or reads for a day - the abandoned-demo half of retention.
				.pexpire(LOG_KEY, RETENTION_MS)
				.del(PENDING_KEY)
				.exec()
			ctx.publish('created', record)
		}
	}
})

/**
 * Schedule the room's alarm `inSeconds` from now (2..600 - the floor
 * keeps e2e runs fast, the cap keeps a shared demo room sane). Records
 * the intent in Redis, then nudges the stream's loader via the control
 * topic; the loader arms the framework alarm. One pending alarm per
 * room: scheduling replaces whatever was pending, for everyone.
 */
export const schedule = live(async (ctx, inSeconds) => {
	const s = Number(inSeconds)
	if (!Number.isFinite(s) || s < MIN_SECONDS || s > MAX_SECONDS) {
		throw new LiveError('VALIDATION', `delay must be ${MIN_SECONDS}..${MAX_SECONDS} seconds`)
	}
	const at = Date.now() + Math.round(s * 1000)
	// TTL far beyond the fire time, never near it: the loader reads this key
	// to reconcile the framework alarm, and an expiry that raced a pending
	// alarm would read as a cancellation. Time-to-fire is capped at
	// MAX_SECONDS, so fire-time plus a full retention window can only expire
	// an intent that is long dead - a crash orphan the fire path never
	// cleared - which is the one case the TTL exists for.
	await redis.redis.set(PENDING_KEY, JSON.stringify({ at, setAt: Date.now() }), 'PX', Math.round(s * 1000) + RETENTION_MS)
	ctx.publish(TOPICS.demoAlarmsControl, 'armed', { at })
	return { ok: true, at }
})

/**
 * Cancel the pending alarm. Clears the Redis intent and nudges the
 * loader, which calls ctx.deleteAlarm() - removing both the in-memory
 * timer and the durable store row.
 */
export const cancel = live(async (ctx) => {
	await redis.redis.del(PENDING_KEY)
	ctx.publish(TOPICS.demoAlarmsControl, 'cancelled', {})
	return { ok: true }
})

/**
 * Pending-alarm probe for the page's countdown card. Returns the
 * scheduled epoch-ms (or null) plus the server clock so the client can
 * render a skew-corrected countdown.
 */
export const pendingAlarm = live(async () => {
	const pending = await readPending()
	return { at: pending?.at ?? null, now: Date.now() }
})
