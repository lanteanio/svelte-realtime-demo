/**
 * The alarms demo's Redis state: the fired log and the pending intent.
 * The client is a parameter so this wiring runs against an in-memory
 * stand-in in the unit tests; the demo passes its shared Redis client.
 */

import { partitionFired, RETENTION_MS } from './alarm-retention.js'

export const LOG_KEY = 'demos:alarms:fired'
export const PENDING_KEY = 'demos:alarms:pending'
export const LOG_CAP = 20

/**
 * The part of the Redis client this module uses.
 * @typedef {{
 *   lrange(key: string, start: number, stop: number): Promise<string[]>,
 *   get(key: string): Promise<string | null>,
 *   set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>,
 *   del(key: string): Promise<unknown>,
 *   eval(script: string, numKeys: number, ...args: string[]): Promise<any>,
 *   multi(): any
 * }} AlarmRedis
 */

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
 * @param {AlarmRedis} client
 * @param {number} now epoch ms
 * @param {(event: string, data: any) => void} [publish]
 */
export async function readLog(client, now, publish) {
	const raws = await client.lrange(LOG_KEY, 0, -1)
	const records = []
	const corrupt = []
	for (const raw of raws) {
		try { records.push({ entry: JSON.parse(raw), raw }) } catch { corrupt.push(raw) }
	}
	const { fresh, stale } = partitionFired(records, now)
	if (stale.length > 0 || corrupt.length > 0) {
		const removal = client.multi()
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

/**
 * Read the pending-alarm intent, or null when none is recorded.
 * @param {AlarmRedis} client
 */
export async function readPending(client) {
	return parseIntent(await client.get(PENDING_KEY))
}

/**
 * The intent a raw PENDING_KEY value holds, or null when it holds none
 * with a usable fire time.
 * @param {string | null | undefined} raw
 */
function parseIntent(raw) {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		return typeof parsed?.at === 'number' && Number.isFinite(parsed.at) ? parsed : null
	} catch {
		return null
	}
}

/**
 * Record a fire only when it fulfils the intent that is pending now, and
 * clear that intent in the same step.
 *
 * One script, so no other client runs between the check and the writes. Any
 * fire whose `at` is not the pending intent's leaves Redis untouched. That
 * covers the same schedule firing a second time, because a loader read the
 * intent before the first fire consumed it and armed it again; a fire in
 * flight when a new schedule replaced its intent or a cancel removed it;
 * another replica's timer, still armed for an older `at`; and a recovered
 * fire whose stored alarm had no `at`, which carries the time it ran as its
 * `at`. An intent still pending at such a fire is one a visitor has already
 * been told is set, so deleting it would drop that alarm; after a cancel
 * there is none, and the fire is only left unlogged. A write that fails
 * changes nothing, so the intent survives for the next loader run to re-arm.
 *
 * The match is numeric equality, so an intent with no `at`, or one spelled
 * as a string, never matches; parseIntent reads no fire time from either.
 *
 * The log's TTL is refreshed on every recorded fire. PEXPIRE on a key that
 * does not exist does nothing, so it follows the LPUSH.
 *
 * KEYS: the log, the intent. ARGV: the record, its `at`, the last index the
 * log keeps, the log's TTL in ms. Returns {1} when recorded, otherwise {0}
 * and the intent's raw value (false when there is none).
 */
const RECORD_FIRE = `
local raw = redis.call('GET', KEYS[2])
if raw then
	local ok, intent = pcall(cjson.decode, raw)
	if ok and type(intent) == 'table' and intent.at == tonumber(ARGV[2]) then
		redis.call('LPUSH', KEYS[1], ARGV[1])
		redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]))
		redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
		redis.call('DEL', KEYS[2])
		return {1}
	end
end
return {0, raw}
`

/**
 * Drop the pending intent.
 * @param {AlarmRedis} client
 */
export async function clearPending(client) {
	await client.del(PENDING_KEY)
}

/**
 * Record the intent to fire `seconds` from now. Returns the fire time.
 * @param {AlarmRedis} client
 * @param {number} seconds already validated by the caller
 */
export async function schedulePending(client, seconds) {
	const now = Date.now()
	const delayMs = Math.round(seconds * 1000)
	const at = now + delayMs
	// TTL far beyond the fire time, never near it: the loader reads this key
	// to reconcile the framework alarm, and an expiry that raced a pending
	// alarm would read as a cancellation. The delay is capped by the caller,
	// so fire-time plus a full retention window can only expire an intent
	// that is long dead - a crash orphan the fire path never cleared - which
	// is the one case the TTL exists for.
	await client.set(PENDING_KEY, JSON.stringify({ at, setAt: now }), 'PX', delayMs + RETENTION_MS)
	return at
}

/**
 * The alarm room's stream loader: reconcile the framework alarm to the
 * recorded intent, then return the fired log, pruned.
 *
 * A stream loader's ctx.publish takes the topic first - only onAlarm's ctx
 * is scoped to the room - so the pruned records' 'deleted' frames name the
 * stream's topic explicitly. Without it they would go to a topic called
 * 'deleted' that nobody subscribes to, and open tabs would keep showing
 * records Redis no longer holds.
 * @param {AlarmRedis} client
 * @param {{ setAlarm(at: number): void, deleteAlarm(): void, publish(topic: string, event: string, data: any): void }} ctx
 * @param {string} topic the stream's own topic
 */
export async function loadRoom(client, ctx, topic) {
	try {
		const pending = await readPending(client)
		if (pending) ctx.setAlarm(pending.at)
		else ctx.deleteAlarm()
	} catch {
		// ctx.setAlarm is bound on the wire-subscribe path; a loader run
		// reached another way (or a Redis blip) leaves the alarm as-is.
	}
	return readLog(client, Date.now(), (event, data) => ctx.publish(topic, event, data))
}

/**
 * The alarm handler: log how the alarm fired and tell the open tabs, when
 * this fire is the one the pending intent asked for.
 *
 * Any other fire records nothing and announces nothing. If an intent is
 * still pending, it is re-armed from here: the fire just consumed the room's
 * alarm, so a replacement scheduled while it was in flight would otherwise
 * wait for the next visitor's loader run to be armed again.
 * @param {AlarmRedis} client
 * @param {{ alarm: { at: number, firedAt: number, lateMs: number, recovered: boolean }, publish(event: string, data: any): void, setAlarm(at: number): void }} ctx
 */
export async function recordFire(client, ctx) {
	const record = {
		id: crypto.randomUUID(),
		at: ctx.alarm.at,
		firedAt: ctx.alarm.firedAt,
		lateMs: ctx.alarm.lateMs,
		recovered: ctx.alarm.recovered
	}
	const [recorded, intent] = await client.eval(
		RECORD_FIRE, 2, LOG_KEY, PENDING_KEY,
		JSON.stringify(record), String(record.at), String(LOG_CAP - 1), String(RETENTION_MS)
	)
	if (recorded === 1) {
		ctx.publish('created', record)
		return
	}
	const pending = parseIntent(intent)
	if (pending) ctx.setAlarm(pending.at)
}
