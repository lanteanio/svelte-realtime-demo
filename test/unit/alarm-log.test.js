import assert from 'node:assert/strict'
import test from 'node:test'
import {
	appendFired, clearPending, loadRoom, LOG_CAP, LOG_KEY, PENDING_KEY, readLog, readPending, recordFire, schedulePending
} from '../../src/lib/server/alarm-log.js'
import { RETENTION_MS } from '../../src/lib/server/alarm-retention.js'

// alarm-retention.test.js pins where the 24-hour boundary falls. This file
// pins the part that changes Redis: a loader that stopped consulting that
// boundary, stopped removing what it finds stale, or stopped setting a TTL
// would leave the boundary tests green while the fired log went back to
// keeping records forever.

const NOW = 1_700_000_000_000

// Enough of a Redis client for this module, and no more forgiving than Redis
// where a difference could hide a bug: PEXPIRE on a missing key does nothing,
// a list emptied by LREM or LTRIM stops existing (taking its TTL with it),
// LREM honours zero and negative counts, and indexes may be negative.
function memoryRedis() {
	const lists = new Map()
	const strings = new Map()
	const ttl = new Map()
	const list = (key) => lists.get(key) ?? []
	const store = (key, values) => {
		if (values.length > 0) lists.set(key, values)
		else { lists.delete(key); ttl.delete(key) }
	}
	const index = (length, i) => (i < 0 ? Math.max(length + i, 0) : i)
	const commands = {
		lpush(key, value) { lists.set(key, [value, ...list(key)]) },
		ltrim(key, start, stop) {
			const l = list(key)
			store(key, l.slice(index(l.length, start), index(l.length, stop) + 1))
		},
		lrem(key, count, value) {
			const l = count < 0 ? [...list(key)].reverse() : list(key)
			const limit = count === 0 ? Infinity : Math.abs(count)
			let removed = 0
			const kept = l.filter((v) => !(v === value && removed < limit && ++removed))
			store(key, count < 0 ? kept.reverse() : kept)
		},
		pexpire(key, ms) { if (lists.has(key) || strings.has(key)) ttl.set(key, ms) },
		del(key) { lists.delete(key); strings.delete(key); ttl.delete(key) },
		set(key, value, mode, ms) {
			strings.set(key, value)
			if (mode === 'PX') ttl.set(key, ms)
			else ttl.delete(key)
		}
	}
	return {
		lists, strings, ttl,
		async lrange(key, start, stop) {
			const l = list(key)
			return l.slice(index(l.length, start), index(l.length, stop) + 1)
		},
		async get(key) { return strings.get(key) ?? null },
		async set(key, value, mode, ms) { commands.set(key, value, mode, ms) },
		async del(key) { commands.del(key) },
		multi() {
			const queued = []
			const chain = {
				exec: async () => { for (const [name, args] of queued) commands[name](...args) }
			}
			for (const name of ['lpush', 'ltrim', 'lrem', 'pexpire', 'del']) {
				chain[name] = (...args) => { queued.push([name, args]); return chain }
			}
			return chain
		}
	}
}

// A stand-in for the room ctx the framework hands the loader and onAlarm.
function roomCtx(alarm) {
	const calls = { setAlarm: [], deleteAlarm: 0, published: [] }
	return {
		calls,
		alarm,
		setAlarm(at) { calls.setAlarm.push(at) },
		deleteAlarm() { calls.deleteAlarm++ },
		publish(event, data) { calls.published.push([event, data]) }
	}
}

const fired = (id, agoMs, now = NOW) =>
	JSON.stringify({ id, at: now - agoMs - 5, firedAt: now - agoMs, lateMs: 5, recovered: false })
const client = (redis) => /** @type {any} */ (redis)

test('the loader returns fresh records and removes stale and corrupt ones from Redis', async () => {
	const redis = memoryRedis()
	const young = fired('young', 1_000)
	const hourOld = fired('hour-old', 60 * 60 * 1000)
	const boundary = fired('boundary', RETENTION_MS)
	const old = fired('old', 2 * RETENTION_MS)
	const corrupt = '{not json'
	const noId = JSON.stringify({ firedAt: NOW - 2 * RETENTION_MS })
	redis.lists.set(LOG_KEY, [young, hourOld, boundary, old, corrupt, noId])

	const published = []
	const rows = await readLog(client(redis), NOW, (event, data) => published.push([event, data]))

	assert.deepEqual(rows.map((row) => row.id), ['young', 'hour-old'])
	assert.deepEqual(redis.lists.get(LOG_KEY), [young, hourOld], 'stale and corrupt entries must leave Redis, not just the reply')
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS)
	// Tabs already subscribed drop what was pruned. A record with no id has
	// nothing a tab could have keyed it by, so it is removed without a publish.
	assert.deepEqual(published, [['deleted', { id: 'boundary' }], ['deleted', { id: 'old' }]])
})

test('a corrupt entry is pruned even when nothing is stale', async () => {
	const redis = memoryRedis()
	const young = fired('young', 1_000)
	redis.lists.set(LOG_KEY, [young, '{not json'])
	const published = []
	const rows = await readLog(client(redis), NOW, (event, data) => published.push([event, data]))
	assert.deepEqual(rows.map((row) => row.id), ['young'])
	assert.deepEqual(redis.lists.get(LOG_KEY), [young])
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS)
	assert.deepEqual(published, [])
})

test('a stale entry is removed by the bytes Redis holds, not by a re-serialisation', async () => {
	// Nothing guarantees the stored text is what JSON.stringify would produce
	// today - another writer, an older build, a different key order - and
	// LREM matches bytes exactly.
	const redis = memoryRedis()
	const young = fired('young', 1_000)
	const spaced = `{ "firedAt": ${NOW - 2 * RETENTION_MS}, "id": "spaced" }`
	redis.lists.set(LOG_KEY, [young, spaced])
	await readLog(client(redis), NOW)
	assert.deepEqual(redis.lists.get(LOG_KEY), [young])
})

test('a record that fires while the loader is pruning survives the prune', async () => {
	const redis = memoryRedis()
	const kept = fired('kept', 1_000)
	const stale = fired('stale', 2 * RETENTION_MS)
	const landing = fired('landing', 0)
	redis.lists.set(LOG_KEY, [kept, stale])
	// The fire lands after the loader's read and before its removal, which
	// shifts every index the read saw by one. Removing by value is what keeps
	// a positional trim from cutting 'kept' off in place of 'stale'.
	const read = redis.lrange
	redis.lrange = async (...args) => {
		const snapshot = await read(...args)
		redis.lists.set(LOG_KEY, [landing, ...redis.lists.get(LOG_KEY)])
		return snapshot
	}

	await readLog(client(redis), NOW)

	assert.deepEqual(redis.lists.get(LOG_KEY), [landing, kept])
})

test('the loader returns at most LOG_CAP records', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, Array.from({ length: LOG_CAP + 5 }, (_, i) => fired(`r${i}`, i * 1_000)))
	const rows = await readLog(client(redis), NOW)
	assert.equal(rows.length, LOG_CAP)
	assert.equal(rows[0].id, 'r0')
})

test('a fire lands at the head, keeps the log at LOG_CAP, refreshes its TTL and clears the intent', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, Array.from({ length: LOG_CAP }, (_, i) => fired(`r${i}`, (i + 1) * 1_000)))
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: NOW, setAt: NOW - 60_000 }))
	const record = { id: 'new', at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false }

	await appendFired(client(redis), record)

	const log = redis.lists.get(LOG_KEY)
	assert.equal(log.length, LOG_CAP)
	assert.deepEqual(JSON.parse(log[0]), record)
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS, 'every fire must refresh the TTL that drains an abandoned log')
	assert.equal(redis.strings.has(PENDING_KEY), false)
})

test('the first fire on an empty log leaves it with a TTL', async () => {
	// PEXPIRE on a key that does not exist yet does nothing, so the order
	// inside the fire's MULTI decides whether a new log can ever drain.
	const redis = memoryRedis()
	await appendFired(client(redis), { id: 'first', at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false })
	assert.equal(redis.lists.get(LOG_KEY)?.length, 1)
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS)
})

test('the alarm handler logs how the alarm fired and publishes the same record', async () => {
	const redis = memoryRedis()
	const alarm = { at: NOW - 40, firedAt: NOW, lateMs: 40, recovered: true }
	const ctx = roomCtx(alarm)
	await recordFire(client(redis), ctx)
	const logged = JSON.parse(redis.lists.get(LOG_KEY)[0])
	assert.deepEqual({ ...logged, id: undefined }, { ...alarm, id: undefined })
	assert.equal(typeof logged.id, 'string')
	assert.deepEqual(ctx.calls.published, [['created', logged]])
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS)
})

test('the stream loader arms the recorded alarm and prunes against the real clock', async () => {
	const redis = memoryRedis()
	const now = Date.now()
	const young = fired('young', 1_000, now)
	redis.lists.set(LOG_KEY, [young, fired('old', 2 * RETENTION_MS, now)])
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: now + 30_000, setAt: now }))
	const ctx = roomCtx()

	const rows = await loadRoom(client(redis), ctx)

	assert.deepEqual(ctx.calls.setAlarm, [now + 30_000])
	assert.equal(ctx.calls.deleteAlarm, 0)
	assert.deepEqual(rows.map((row) => row.id), ['young'])
	assert.deepEqual(redis.lists.get(LOG_KEY), [young])
	assert.deepEqual(ctx.calls.published, [['deleted', { id: 'old' }]])
})

test('the stream loader clears the alarm when no intent is recorded, and a refused alarm still returns the log', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000, Date.now())])
	const idle = roomCtx()
	assert.equal((await loadRoom(client(redis), idle)).length, 1)
	assert.equal(idle.calls.deleteAlarm, 1)

	redis.strings.set(PENDING_KEY, JSON.stringify({ at: Date.now() + 5_000, setAt: Date.now() }))
	const refusing = { ...roomCtx(), setAlarm() { throw new Error('not bound on this path') } }
	assert.equal((await loadRoom(client(redis), refusing)).length, 1)
})

test('scheduling records the intent with a TTL a full retention window past its fire time', async () => {
	const redis = memoryRedis()
	const before = Date.now()
	const at = await schedulePending(client(redis), 120)
	const after = Date.now()
	assert.ok(at >= before + 120_000 && at <= after + 120_000, `fire time ${at} is not 120s from now`)
	assert.equal(redis.ttl.get(PENDING_KEY), 120_000 + RETENTION_MS)
	const pending = await readPending(client(redis))
	assert.equal(pending?.at, at)
	assert.equal(at - pending.setAt, 120_000)

	await clearPending(client(redis))
	assert.equal(await readPending(client(redis)), null)
})

test('an intent without a usable fire time reads as none', async () => {
	const redis = memoryRedis()
	for (const raw of ['{not json', '{"at":"soon"}', '{"at":null}', '{}']) {
		redis.strings.set(PENDING_KEY, raw)
		assert.equal(await readPending(client(redis)), null, raw)
	}
})
