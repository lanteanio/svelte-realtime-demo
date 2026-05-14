/**
 * /demos/notifications - live.push request/reply + cluster registry
 * + 6-field live.cron scheduler.
 *
 * The pitch: pick another connected user, type a one-liner, hit Send.
 * The server calls `live.push({ userId }, 'demos:notification', ...)`
 * and AWAITS a reply - the recipient's tab pops a card with two
 * buttons (Got it / Dismiss); the value they click comes back as the
 * sender's RPC return. With "schedule N seconds" checked, the message
 * lands in an in-memory queue drained by a `live.cron('* * * * * *')`
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
 * Storage is in-memory (demo only). The activity log is capped at
 * ACTIVITY_CAP entries with FIFO eviction; older entries get a
 * 'deleted' event so the client list stays bounded.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

const PUSH_TIMEOUT_MS = 8000
const ACTIVITY_CAP = 50
const MAX_TEXT_LEN = 200
const MAX_SCHEDULE_SEC = 120

/** @type {Map<string, { id: string, fromUserId: string, fromUserName: string, fromUserColor: string, toUserId: string, toUserName: string, text: string, fireAt: number }>} */
const scheduled = new Map()

/** @type {Array<object>} - newest first, capped at ACTIVITY_CAP. */
const activity = []

function appendActivity(entry, ctx) {
	activity.unshift(entry)
	if (activity.length > ACTIVITY_CAP) {
		const dropped = activity.pop()
		ctx.publish(TOPICS.demoNotificationsActivity, 'deleted', { id: dropped.id })
	}
	ctx.publish(TOPICS.demoNotificationsActivity, 'created', entry)
}

/**
 * Fire one push and report the outcome to the activity log.
 *
 * On reply: `delivered` (ack: 'ok') or `dismissed` (ack: 'dismiss').
 * On timeout: `timeout`. On NOT_FOUND: `offline`. The recipient is
 * offline if neither this instance's local registry nor the cluster
 * registry has them. Other LiveErrors surface as 'error'.
 *
 * Returns a flat object the sender's RPC can render in its outcome
 * banner without re-throwing.
 */
async function deliverPush(entry, ctx) {
	const { id, fromUserName, fromUserColor, toUserId, toUserName, text } = entry
	try {
		const reply = await live.push(
			{ userId: toUserId },
			'demos:notification',
			{ id, fromUserName, fromUserColor, text, sentAt: Date.now() },
			{ timeoutMs: PUSH_TIMEOUT_MS }
		)
		const ack = reply?.ack === 'dismiss' ? 'dismiss' : 'ok'
		appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind: ack === 'dismiss' ? 'dismissed' : 'delivered',
			pushId: id,
			fromUserName,
			toUserName,
			text
		}, ctx)
		return { ok: true, ack }
	} catch (err) {
		const code = err instanceof LiveError ? err.code : null
		const kind = code === 'NOT_FOUND' ? 'offline' : (code === 'TIMEOUT' ? 'timeout' : 'error')
		appendActivity({
			id: crypto.randomUUID(),
			ts: Date.now(),
			kind,
			pushId: id,
			fromUserName,
			toUserName,
			text,
			error: err?.message ?? String(err)
		}, ctx)
		return { ok: false, kind, error: err?.message ?? String(err) }
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
	const scheduledCount = scheduled.size
	for (const id of Array.from(scheduled.keys())) {
		ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id })
	}
	scheduled.clear()
	const activityCount = activity.length
	for (const entry of activity) {
		ctx.publish(TOPICS.demoNotificationsActivity, 'deleted', { id: entry.id })
	}
	activity.length = 0
	return { scheduled: scheduledCount, activity: activityCount }
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
		scheduled.set(id, entry)
		ctx.publish(TOPICS.demoNotificationsScheduled, 'created', entry)
		appendActivity({
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
 * NOT_FOUND if the id has already fired or never existed.
 */
export const cancelScheduled = live(async (ctx, id) => {
	if (typeof id !== 'string') throw new LiveError('VALIDATION', 'id required')
	const entry = scheduled.get(id)
	if (!entry) throw new LiveError('NOT_FOUND', 'no such scheduled notification')
	scheduled.delete(id)
	ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id })
	appendActivity({
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
	async () => Array.from(scheduled.values()),
	{ merge: 'crud', key: 'id' }
)

/**
 * Live stream of recent activity. Capped client- and server-side at
 * ACTIVITY_CAP. Newest first; FIFO-evicted on overflow.
 */
export const recentActivity = live.stream(
	TOPICS.demoNotificationsActivity,
	async () => activity.slice(),
	{ merge: 'crud', key: 'id' }
)

/**
 * Scheduler tick. 6-field cron: every second.
 *
 * Scans for due entries, removes them from the queue, and fires each
 * push fire-and-forget. The push's reply (or timeout / offline) lands
 * in the activity stream when it resolves - the tick itself does NOT
 * await individual deliveries, so a recipient with the inbox closed
 * can't block the next tick.
 *
 * Single-flight: if a tick body somehow runs longer than
 * 1s, the next tick is skipped (visible as `cronCount{status:'skipped'}`
 * in metrics) instead of overlapping. Returning undefined suppresses
 * the cron's automatic 'set' publish; we use ctx.publish per affected
 * entry instead.
 */
export const tickScheduler = live.cron('* * * * * *', TOPICS.demoNotificationsScheduled, async (ctx) => {
	const now = Date.now()
	const due = []
	for (const entry of scheduled.values()) {
		if (entry.fireAt <= now) due.push(entry)
	}
	if (due.length === 0) return
	for (const entry of due) {
		scheduled.delete(entry.id)
		ctx.publish(TOPICS.demoNotificationsScheduled, 'deleted', { id: entry.id })
		appendActivity({
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
