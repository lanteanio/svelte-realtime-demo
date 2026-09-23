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
	const raw = await client.get(PENDING_KEY)
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		return typeof parsed?.at === 'number' && Number.isFinite(parsed.at) ? parsed : null
	} catch {
		return null
	}
}

/**
 * Put a fired record at the head of the log and clear the intent it
 * fulfilled.
 * @param {AlarmRedis} client
 * @param {{ id: string, at: number, firedAt: number, lateMs: number, recovered: boolean }} record
 */
export async function appendFired(client, record) {
	await client.multi()
		.lpush(LOG_KEY, JSON.stringify(record))
		.ltrim(LOG_KEY, 0, LOG_CAP - 1)
		// The whole-key TTL, refreshed per fire: age-pruning happens on
		// read, and this is what drains the key to nothing when nobody
		// fires or reads for a day - the abandoned-demo half of retention.
		.pexpire(LOG_KEY, RETENTION_MS)
		.del(PENDING_KEY)
		.exec()
}

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
 * @param {AlarmRedis} client
 * @param {{ setAlarm(at: number): void, deleteAlarm(): void, publish(event: string, data: any): void }} ctx
 */
export async function loadRoom(client, ctx) {
	try {
		const pending = await readPending(client)
		if (pending) ctx.setAlarm(pending.at)
		else ctx.deleteAlarm()
	} catch {
		// ctx.setAlarm is bound on the wire-subscribe path; a loader run
		// reached another way (or a Redis blip) leaves the alarm as-is.
	}
	return readLog(client, Date.now(), (event, data) => ctx.publish(event, data))
}

/**
 * The alarm handler: log how the alarm fired and tell the open tabs.
 * @param {AlarmRedis} client
 * @param {{ alarm: { at: number, firedAt: number, lateMs: number, recovered: boolean }, publish(event: string, data: any): void }} ctx
 */
export async function recordFire(client, ctx) {
	const record = {
		id: crypto.randomUUID(),
		at: ctx.alarm.at,
		firedAt: ctx.alarm.firedAt,
		lateMs: ctx.alarm.lateMs,
		recovered: ctx.alarm.recovered
	}
	await appendFired(client, record)
	ctx.publish('created', record)
}
