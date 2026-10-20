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
 * survives worker restarts. An atomic generation-fenced claim retains
 * the execution until its callback completes, so the precise timer and
 * the recovery poll cannot both run the same scheduled generation.
 *
 * Arming pattern: `ctx.setAlarm` lives on the STREAM's ctx (it is
 * bound on the subscribe path) and on onAlarm's, not on a bare
 * `live()` RPC ctx, so the RPCs cannot arm the alarm themselves. The
 * schedule / cancel RPCs therefore record intent in Redis and publish
 * a nudge on a
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
 * timestamps - no user content, no PII. Redis keys follow ctx.tenantId so
 * pending intents, fired records and retention share the stream's scope.
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
 * true for this demo rather than aspirational. The Redis side of all of
 * this lives in $lib/server/alarm-log, where it is unit-tested.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'
import { clearPending, loadRoom, readPending, recordFire, schedulePending } from '$lib/server/alarm-log'

const MIN_SECONDS = 2
const MAX_SECONDS = 600

/**
 * The alarm room. The loader returns the fired log AND reconciles the
 * framework alarm to the Redis intent: pending -> setAlarm(at) (replace
 * semantics make re-arming from every subscriber idempotent), no
 * pending -> deleteAlarm(). `invalidateOn` on the control topic re-runs the
 * loader whenever schedule / cancel publish their nudge, so the
 * reconcile happens within one round-trip of the click.
 *
 * onAlarm runs with a fresh ws-less server ctx even if every tab is
 * closed. When the fire is the one the Redis intent asked for, it
 * appends the fired record to the log and clears the intent in one
 * atomic step, then publishes 'created' into this room so open tabs see
 * the record land live. Any other fire - the same schedule re-armed by a
 * loader that read the intent mid-fire, or an alarm replaced or cancelled
 * while it was firing - records nothing and re-arms whatever intent is
 * still pending, so every schedule is logged at most once and a newer one
 * is never dropped.
 */
export const timers = live.stream(TOPICS.demoAlarmsLog, (ctx) => loadRoom(redis.redis, ctx, TOPICS.demoAlarmsLog), {
	merge: 'crud',
	key: 'id',
	invalidateOn: TOPICS.demoAlarmsControl,
	alarm: {
		onAlarm: (ctx) => recordFire(redis.redis, ctx)
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
	const at = await schedulePending(redis.redis, s, ctx.tenantId)
	ctx.publish(TOPICS.demoAlarmsControl, 'armed', { at })
	return { ok: true, at }
})

/**
 * Cancel the pending alarm. Clears the Redis intent and nudges the
 * loader, which calls ctx.deleteAlarm() - removing both the in-memory
 * timer and the durable store row.
 */
export const cancel = live(async (ctx) => {
	await clearPending(redis.redis, ctx.tenantId)
	ctx.publish(TOPICS.demoAlarmsControl, 'cancelled', {})
	return { ok: true }
})

/**
 * Pending-alarm probe for the page's countdown card. Returns the
 * scheduled epoch-ms (or null) plus the server clock so the client can
 * render a skew-corrected countdown.
 */
export const pendingAlarm = live(async (ctx) => {
	const pending = await readPending(redis.redis, ctx.tenantId)
	return { at: pending?.at ?? null, now: Date.now() }
})
