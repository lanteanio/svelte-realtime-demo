import assert from 'node:assert/strict'
import test from 'node:test'
import {
	appendFired, clearPending, LOG_CAP, LOG_KEY, PENDING_KEY, readLog, readPending, writePending
} from '../../src/lib/server/alarm-log.js'
import { RETENTION_MS } from '../../src/lib/server/alarm-retention.js'

// alarm-retention.test.js pins where the 24-hour boundary falls. This file
// pins the part that changes Redis: a loader that stopped consulting that
// boundary, stopped removing what it finds stale, or stopped setting a TTL
// would leave the boundary tests green while the fired log went back to
// keeping records forever.

const NOW = 1_700_000_000_000

// Enough of a Redis client for this module: lists, strings, per-key TTLs,
// and MULTI queueing its commands until exec.
function memoryRedis() {
	const lists = new Map()
	const strings = new Map()
	const ttl = new Map()
	const list = (key) => lists.get(key) ?? []
	const commands = {
		lpush(key, value) { lists.set(key, [value, ...list(key)]) },
		ltrim(key, start, stop) { lists.set(key, list(key).slice(start, stop + 1)) },
		lrem(key, count, value) {
			let removed = 0
			lists.set(key, list(key).filter((v) => !(v === value && removed < count && ++removed)))
		},
		pexpire(key, ms) { ttl.set(key, ms) },
		del(key) { lists.delete(key); strings.delete(key); ttl.delete(key) },
		set(key, value, mode, ms) {
			strings.set(key, value)
			if (mode === 'PX') ttl.set(key, ms)
			else ttl.delete(key)
		}
	}
	return {
		lists, strings, ttl,
		async lrange(key, start, stop) { return list(key).slice(start, stop === -1 ? undefined : stop + 1) },
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

const fired = (id, agoMs) => JSON.stringify({ id, at: NOW - agoMs - 5, firedAt: NOW - agoMs, lateMs: 5, recovered: false })

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
	const rows = await readLog(/** @type {any} */ (redis), NOW, (event, data) => published.push([event, data]))

	assert.deepEqual(rows.map((row) => row.id), ['young', 'hour-old'])
	assert.deepEqual(redis.lists.get(LOG_KEY), [young, hourOld], 'stale and corrupt entries must leave Redis, not just the reply')
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS)
	// Tabs already subscribed drop what was pruned. A record with no id has
	// nothing a tab could have keyed it by, so it is removed without a publish.
	assert.deepEqual(published, [['deleted', { id: 'boundary' }], ['deleted', { id: 'old' }]])
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

	await readLog(/** @type {any} */ (redis), NOW)

	assert.deepEqual(redis.lists.get(LOG_KEY), [landing, kept])
})

test('the loader returns at most LOG_CAP records', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, Array.from({ length: LOG_CAP + 5 }, (_, i) => fired(`r${i}`, i * 1_000)))
	const rows = await readLog(/** @type {any} */ (redis), NOW)
	assert.equal(rows.length, LOG_CAP)
	assert.equal(rows[0].id, 'r0')
})

test('a fire lands at the head, keeps the log at LOG_CAP, refreshes its TTL and clears the intent', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, Array.from({ length: LOG_CAP }, (_, i) => fired(`r${i}`, (i + 1) * 1_000)))
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: NOW, setAt: NOW - 60_000 }))
	const record = { id: 'new', at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false }

	await appendFired(/** @type {any} */ (redis), record)

	const log = redis.lists.get(LOG_KEY)
	assert.equal(log.length, LOG_CAP)
	assert.deepEqual(JSON.parse(log[0]), record)
	assert.equal(redis.ttl.get(LOG_KEY), RETENTION_MS, 'every fire must refresh the TTL that drains an abandoned log')
	assert.equal(redis.strings.has(PENDING_KEY), false)
})

test('the pending intent outlives its fire time by a full retention window', async () => {
	const redis = memoryRedis()
	await writePending(/** @type {any} */ (redis), NOW + 120_000, 120_000, NOW)
	assert.equal(redis.ttl.get(PENDING_KEY), 120_000 + RETENTION_MS)
	assert.deepEqual(await readPending(/** @type {any} */ (redis)), { at: NOW + 120_000, setAt: NOW })

	await clearPending(/** @type {any} */ (redis))
	assert.equal(await readPending(/** @type {any} */ (redis)), null)

	redis.strings.set(PENDING_KEY, '{not json')
	assert.equal(await readPending(/** @type {any} */ (redis)), null)
})
