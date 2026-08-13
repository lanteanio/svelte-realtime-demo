// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/notifications - live.push request/reply + cluster registry
 * + 6-field live.cron scheduler.
 *
 * The pitch: pick another connected user, type a one-liner, hit Send.
 * The server calls `live.push({ userId }, 'demos:notification', ...)`
 * and AWAITS a reply - the recipient's tab pops a card with two
 * buttons (Got it / Dismiss); the value they click comes back as the
 * sender's RPC return. With "schedule N seconds" checked, the message
 * lands in a cluster-shared Redis hash drained by a `live.cron('* * * * * *')`
 * tick (6-field cron, fires every second). Cancel removes a
 * pending entry before it fires.
 *
 * Three feature primitives in one demo:
 *
 *  - live.push(target, event, data, { timeoutMs })
 *      - realtime's server-initiated request/reply. Local-instance
 *      hits go through `platform.request(ws, ...)` (no Redis hop);
 *      cross-instance hits fall through `live.configurePush({
 *      remoteRegistry })` to `registry.request(userId, ...)`. Wired
 *      in src/hooks.ws.js.
 *
 *  - The extensions cluster connection registry
 *      - src/lib/server/redis.js exports `registry`; hooks.ws.js
 *      runs `registry.hooks.open` / `.close` per connection so the
 *      Redis-backed userId -> instance map stays current. Single-
 *      instance dev never hits the cluster path, but the wiring is
 *      production-shaped.
 *
 *  - live.cron with a 6-field schedule
 *      - added seconds-resolution cron expressions. Once any
 *      6-field schedule is registered, the engine's tick adapts from
 *      60s to 1Hz (sticky). Single-flight: a long-running tick won't
 *      overlap with itself; pushes inside the tick are fire-and-forget
 *      so the tick stays fast even when a recipient is offline and
 *      the push waits the full timeout.
 *
 * Storage is cluster-shared via Redis (HASH for the scheduler queue +
 * capped LIST for the activity log). A scheduled push enqueued on
 * Replica A is visible to the leader-gated tick on Replica B; the
 * activity log appended on any replica is visible to subscribers on
 * every replica via the cluster pub/sub fan-out plus the loader read.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { leader, redis, registry } from '$lib/server/redis'

const PUSH_TIMEOUT_MS = 8000
const ACTIVITY_CAP = 50
const MAX_TEXT_LEN = 200
const MAX_SCHEDULE_SEC = 120

const SCHEDULED_KEY = 'demos:notifications:scheduled'
const ACTIVITY_KEY = 'demos:notifications:activity'

async function listScheduled() {
	const raws = await redis.redis.hvals(SCHEDULED_KEY)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

async function listActivity() {
	const raws = await redis.redis.lrange(ACTIVITY_KEY, 0, -1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

/**
 * LPUSH puts newest first; LTRIM bounds the list at ACTIVITY_CAP. The
 * single pipelined round-trip captures any evicted entry from the
 * post-LPUSH state via LRANGE(ACTIVITY_CAP, -1) before LTRIM drops
 * everything past the cap, so subscribers see a 'deleted' event per
 * evicted entry instead of a silent disappearance.
 */
async function appendActivity(entry, ctx) {
	// Stamp the worker that handled this step. On a multi-replica
	// deployment a schedule and its fire routinely land on different
	// workers - the differing ids are the only visible evidence of the
	// cluster registry doing its relay work.
	entry.instance = (leader.instanceId ?? 'local').slice(0, 8)
	const raw = JSON.stringify(entry)
	const pipeline = redis.redis.multi()
	pipeline.lpush(ACTIVITY_KEY, raw)
	pipeline.lrange(ACTIVITY_KEY, ACTIVITY_CAP, -1)
	pipeline.ltrim(ACTIVITY_KEY, 0, ACTIVITY_CAP - 1)
	const results = await pipeline.exec()
	const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
	for (const evictedRaw of evicted) {
		try {
			const dropped = JSON.parse(evictedRaw)
			ctx.publish(TOPICS.demoNotificationsActivity, 'deleted', { id: dropped.id })
		} catch { /* corrupt entry already evicted */ }
	}
	ctx.publish(TOPICS.demoNotificationsActivity, 'created', entry)
}

/**
 * Which way a push is about to travel, read from the cluster registry that
 * decides it.
 *
 * `live.push` picks its own path internally - a local socket goes through
 * `platform.request`, anything else falls through to `registry.request` - and
 * reports only the reply, so the one thing this demo exists to show is the one
 * thing the call does not tell you. Asking the registry the same question it
 * will ask is what makes the hop visible.
 *
 * Compared against `registry.instanceId`, never `leader.instanceId`: the
 * registry generates its own id and writes THAT into every connection row, so
 * the leader's id is an unrelated random string and comparing to it would
 * label every recipient remote, including on a single-instance dev box where
 * no hop is possible at all.
 *
 * A recipient with no row is not offline-by-omission here: the push still
 * runs, and its own NOT_FOUND is what settles that.
 */
async function deliveryPath(toUserId) {
	try {
		const owner = await registry.lookup(toUserId)
		if (!owner?.instanceId) return { via: 'unknown', toInstance: null }
		const via = owner.instanceId === registry.instanceId ? 'local' : 'cluster'
		return { via, toInstance: owner.instanceId.slice(0, 8) }
	} catch {
		// The badge is a teaching aid; a registry read that fails must not
		// take the notification down with it.
		return { via: 'unknown', toInstance: null }
	}
}

/**
 * Fire one push and report the outcome to the activity log.
 *
 * On reply: `delivered` (ack: 'ok') or `dismissed` (ack: 'dismiss').
 * On timeout: `timeout`. On NOT_FOUND: `offline`. The recipient is
 * offline if neither this instance's local registry nor the cluster
 * registry has them. Other LiveErrors surface as 'error'.
 *
 * Every outcome also carries the path the push took, so a delivery that
 * crossed instances is distinguishable from one that never left this one.
 *
 * Returns a flat object the sender's RPC can render in its outcome
 * banner without re-throwing.
 */
async function deliverPush(entry, ctx) {
	const { id, fromUserName, fromUserColor, toUserId, toUserName, text } = entry
	const path = await deliveryPath(toUserId)
	try {
		const reply = await live.push(
			{ userId: toUserId },
			'demos:notification',
			{ id, fromUserName, fromUserColor, text, sentAt: Date.now() },
			{ timeoutMs: PUSH_TIMEOUT_MS }
		)
		const ack = reply?.ack === 'dismiss' ? 'dismiss' : 'ok'
		await appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind: ack === 'dismiss' ? 'dismissed' : 'delivered',
			pushId: id,
			fromUserName,
			toUserName,
			text,
			via: path.via,
			toInstance: path.toInstance
		}, ctx)
		return { ok: true, ack, via: path.via, toInstance: path.toInstance }
	} catch (err) {
		const code = err instanceof LiveError ? err.code : null
		const kind = code === 'NOT_FOUND' ? 'offline' : (code === 'TIMEOUT' ? 'timeout' : 'error')
		await appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind,
			pushId: id,
			fromUserName,
			toUserName,
			text,
			via: path.via,
			toInstance: path.toInstance,
			error: err?.message ?? String(err)
		}, ctx)
		return { ok: false, kind, via: path.via, toInstance: path.toInstance, error: err?.message ?? String(err) }
	}
}

/**
 * Wipe the scheduler queue and the activity log. A scheduled push that
 * was queued 25 minutes ago and would have fired into a stale UI is
 * worse than cancelling it, so we drop pending entries on purge.
 * In-flight live.push awaiters (immediate sends) are not affected;
 * those resolve naturally.
 */
export async function purge(ctx) {
	// Snapshot before delete so we can publish 'deleted' per id. A race
	// with a concurrent schedule is harmless: the new entry survives the
	// HDEL window and shows up on next subscribe.
	const scheduledIds = await redis.redis.hkeys(SCHEDULED_KEY)
	const activityRaws = await redis.redis.lrange(ACTIVITY_KEY, 0, -1)

	const pipeline = redis.redis.multi()
	pipeline.del(SCHEDULED_KEY)
	pipeline.del(ACTIVITY_KEY)
	await pipeline.exec()

	for (const id of scheduledIds) {
		ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id })
	}
	for (const raw of activityRaws) {
		try {
			const entry = JSON.parse(raw)
			ctx.publish(TOPICS.demoNotificationsActivity, 'deleted', { id: entry.id })
		} catch { /* corrupt entry already gone */ }
	}
	return { scheduled: scheduledIds.length, activity: activityRaws.length }
}

/**
 * Send (or schedule) a notification. Object-arg form for clarity --
 * 4 positional args were getting awkward.
 *
 *   sendNotification({
 *     recipientId: 'uuid',
 *     recipientName: 'Visible Name',
 *     text: 'Hello there',
 *     scheduleSec: 0    // 0 = immediate; 1..120 = schedule N seconds out
 *   })
 *
 * Immediate sends return the deliver outcome (`{ ok, ack }` or
 * `{ ok: false, kind, error }`). Scheduled sends return
 * `{ ok: true, scheduled: true, id, fireAt }` and the entry shows up
 * in the scheduledNotifications stream.
 */
export const sendNotification = live(async (ctx, args) => {
	const { recipientId, recipientName, text, scheduleSec } = args ?? {}
	if (typeof recipientId !== 'string' || recipientId.length === 0) {
		throw new LiveError('VALIDATION', 'recipientId required')
	}
	if (recipientId === ctx.user?.id) {
		throw new LiveError('VALIDATION', 'cannot send to yourself')
	}
	if (typeof text !== 'string' || text.trim().length === 0) {
		throw new LiveError('VALIDATION', 'text required')
	}
	const cleanText = text.trim().slice(0, MAX_TEXT_LEN)
	const sec = Math.max(0, Math.min(MAX_SCHEDULE_SEC, Number(scheduleSec) || 0))

	const fromUserName = ctx.user?.name ?? '(unknown)'
	const fromUserColor = ctx.user?.color ?? '#888'
	const fromUserId = ctx.user?.id ?? null
	const toUserName = typeof recipientName === 'string' ? recipientName.slice(0, 40) : '(unknown)'

	if (sec > 0) {
		const id = crypto.randomUUID()
		const fireAt = Date.now() + sec * 1000
		const entry = { id, fromUserId, fromUserName, fromUserColor, toUserId: recipientId, toUserName, text: cleanText, fireAt }
		await redis.redis.hset(SCHEDULED_KEY, id, JSON.stringify(entry))
		ctx.publish(TOPICS.demoNotificationsScheduled, 'created', entry)
		await appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind: 'scheduled',
			pushId: id,
			fromUserName,
			toUserName,
			text: cleanText,
			fireAt
		}, ctx)
		return { ok: true, scheduled: true, id, fireAt }
	}

	const entry = {
		id: crypto.randomUUID(),
		fromUserId,
		fromUserName,
		fromUserColor,
		toUserId: recipientId,
		toUserName,
		text: cleanText
	}
	return deliverPush(entry, ctx)
})

/**
 * Cancel a pending scheduled notification before it fires. Throws
 * NOT_FOUND if the id has already fired or never existed. The HDEL
 * is the source of truth; the get-before-delete is purely for the
 * activity-log payload (sender / recipient names + the original text).
 */
export const cancelScheduled = live(async (ctx, id) => {
	if (typeof id !== 'string') throw new LiveError('VALIDATION', 'id required')
	const raw = await redis.redis.hget(SCHEDULED_KEY, id)
	if (!raw) throw new LiveError('NOT_FOUND', 'no such scheduled notification')
	let entry
	try { entry = JSON.parse(raw) } catch { throw new LiveError('NOT_FOUND', 'no such scheduled notification') }
	const removed = await redis.redis.hdel(SCHEDULED_KEY, id)
	if (removed === 0) throw new LiveError('NOT_FOUND', 'no such scheduled notification')
	ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id })
	await appendActivity({
		id: crypto.randomUUID(),
		ts: Date.now(),
		kind: 'cancelled',
		pushId: id,
		fromUserName: entry.fromUserName,
		toUserName: entry.toUserName,
		text: entry.text
	}, ctx)
	return { ok: true, id }
})

/**
 * Live stream of pending scheduled notifications across all users.
 * One global queue keeps the demo simple; production would scope by
 * sender or recipient.
 */
export const scheduledNotifications = live.stream(
	TOPICS.demoNotificationsScheduled,
	async () => listScheduled(),
	{ merge: 'crud', key: 'id' }
)

/**
 * Live stream of recent activity. Capped client- and server-side at
 * ACTIVITY_CAP. Newest first; FIFO-evicted on overflow.
 */
export const recentActivity = live.stream(
	TOPICS.demoNotificationsActivity,
	async () => listActivity(),
	{ merge: 'crud', key: 'id' }
)

/**
 * Scheduler tick. 6-field cron: every second.
 *
 * Scans for due entries via HVALS, removes them from the queue, and
 * fires each push fire-and-forget. The push's reply (or timeout /
 * offline) lands in the activity stream when it resolves - the tick
 * itself does NOT await individual deliveries, so a recipient with the
 * inbox closed can't block the next tick.
 *
 * Single-flight; cluster-singleton via configureCron({ leader }) wired
 * in src/hooks.ws.js init.
 */
export const tickScheduler = live.cron('* * * * * *', TOPICS.demoNotificationsScheduled, async (ctx) => {
	const now = Date.now()
	const all = await listScheduled()
	const due = all.filter((entry) => entry.fireAt <= now)
	if (due.length === 0) return
	for (const entry of due) {
		// HDEL returns 1 if removed, 0 if already gone (race with cancel).
		// Skip publishing 'deleted' for a race-loser; the cancel path
		// already published the deletion when it won.
		const removed = await redis.redis.hdel(SCHEDULED_KEY, entry.id)
		if (removed === 0) continue
		ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id: entry.id })
		await appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind: 'fired',
			pushId: entry.id,
			fromUserName: entry.fromUserName,
			toUserName: entry.toUserName,
			text: entry.text
		}, ctx)
		deliverPush(entry, ctx).catch(() => {})
	}
})
