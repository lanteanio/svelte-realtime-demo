import assert from 'node:assert/strict'
import test from 'node:test'
import {
	clearPending, loadRoom, LOG_CAP, LOG_KEY, PENDING_KEY, readLog, readPending, recordFire, schedulePending
} from '../../src/lib/server/alarm-log.js'
import { RETENTION_MS } from '../../src/lib/server/alarm-retention.js'

// alarm-retention.test.js pins where the 24-hour boundary falls. This file
// pins the part that changes Redis: a loader that stopped consulting that
// boundary, stopped removing what it finds stale, or stopped setting a TTL
// would leave the boundary tests green while the fired log went back to
// keeping records forever.
//
// The fire itself is one Lua script, which this stand-in cannot run. What the
// script does to Redis is pinned against a real server in
// test/e2e/alarm-log.redis.spec.js; here `eval` answers with whatever reply a
// test scripts, which pins what the handler does with each answer.

const NOW = 1_700_000_000_000

// Every command reaches "the server" a macrotask later, in order, the way a
// socket round trip does, so a write the module forgot to await has not
// happened yet when the module returns.
const roundTrip = () => new Promise((resolve) => setImmediate(resolve))

// Enough of a Redis client for this module, and no more forgiving than Redis
// where a difference could hide a bug: writes land a round trip later, PEXPIRE
// on a missing key does nothing, a list emptied by LREM stops existing (taking
// its TTL with it), LREM honours zero and negative counts, LRANGE indexes may
// be negative, and a TTL must be a positive integer. Inside MULTI a rejected
// command fails alone and the rest still apply, as EXEC does. MULTI takes only
// the two commands the loader's prune queues, LREM and PEXPIRE, so a fire that
// went back to pushing its record through MULTI would throw here.
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
	const integer = (ms) => {
		if (!Number.isInteger(ms)) throw new Error('ERR value is not an integer or out of range')
	}
	const commands = {
		lrem(key, count, value) {
			const l = count < 0 ? [...list(key)].reverse() : list(key)
			const limit = count === 0 ? Infinity : Math.abs(count)
			let removed = 0
			const kept = l.filter((v) => !(v === value && removed < limit && ++removed))
			store(key, count < 0 ? kept.reverse() : kept)
		},
		pexpire(key, ms) {
			integer(ms)
			if (!(lists.has(key) || strings.has(key))) return
			if (ms <= 0) commands.del(key)
			else ttl.set(key, ms)
		},
		del(key) { lists.delete(key); strings.delete(key); ttl.delete(key) },
		set(key, value, mode, ms) {
			if (mode === 'PX') {
				integer(ms)
				if (ms <= 0) throw new Error("ERR invalid expire time in 'set' command")
			}
			strings.set(key, value)
			if (mode === 'PX') ttl.set(key, ms)
			else ttl.delete(key)
		}
	}
	// A command named in `failing` rejects the way a dropped connection does,
	// having changed nothing.
	const reply = async (name) => {
		await roundTrip()
		if (redis.failing.has(name)) throw new Error(`connection lost during ${name}`)
	}
	const redis = {
		lists, strings, ttl, multis: 0, failing: new Set(),
		async lrange(key, start, stop) {
			await reply('lrange')
			const l = list(key)
			return l.slice(index(l.length, start), index(l.length, stop) + 1)
		},
		async get(key) { await reply('get'); return strings.get(key) ?? null },
		async set(key, value, mode, ms) { await reply('set'); commands.set(key, value, mode, ms) },
		async del(key) { await reply('del'); commands.del(key) },
		// Records every script call and answers with evalReply, changing
		// nothing in the stand-in's state.
		evals: [],
		/** @type {Array<number | string | null>} */
		evalReply: [1],
		async eval(script, numKeys, ...args) {
			await reply('eval')
			redis.evals.push({ keys: args.slice(0, numKeys), argv: args.slice(numKeys) })
			return redis.evalReply
		},
		multi() {
			redis.multis++
			const queued = []
			const chain = {
				exec: async () => {
					await reply('exec')
					for (const [name, args] of queued) {
						try { commands[name](...args) } catch { /* fails alone, as in EXEC */ }
					}
				}
			}
			for (const name of ['lrem', 'pexpire']) {
				chain[name] = (...args) => { queued.push([name, args]); return chain }
			}
			return chain
		}
	}
	return redis
}

// Stand-ins for the two ctx shapes the framework hands this module, which
// differ in the one way that matters here: a stream loader's publish takes the
// topic first, onAlarm's is already scoped to the room.
const TOPIC = 'demos:alarms:log'

function streamCtx() {
	const calls = { setAlarm: [], deleteAlarm: 0, published: [] }
	return {
		calls,
		setAlarm(at) { calls.setAlarm.push(at) },
		deleteAlarm() { calls.deleteAlarm++ },
		publish(topic, event, data) { calls.published.push([topic, event, data]) }
	}
}

function alarmCtx(alarm) {
	const calls = { published: [], setAlarm: [] }
	return {
		calls,
		alarm,
		publish(event, data) { calls.published.push([event, data]) },
		setAlarm(at) { calls.setAlarm.push(at) }
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

test('the alarm handler hands the script how the alarm fired, and publishes the record it recorded', async () => {
	const redis = memoryRedis()
	const alarm = { at: NOW - 40, firedAt: NOW, lateMs: 40, recovered: true }
	const ctx = alarmCtx(alarm)
	await recordFire(client(redis), ctx)
	assert.equal(redis.evals.length, 1)
	const [{ keys, argv }] = redis.evals
	assert.deepEqual(keys, [LOG_KEY, PENDING_KEY])
	const logged = JSON.parse(argv[0])
	assert.deepEqual({ ...logged, id: undefined }, { ...alarm, id: undefined })
	assert.equal(typeof logged.id, 'string')
	// The script matches the intent on the fire time and keeps LOG_CAP
	// entries under a RETENTION_MS TTL; each travels as its own argument.
	assert.deepEqual(argv.slice(1), [String(alarm.at), String(LOG_CAP - 1), String(RETENTION_MS)])
	assert.deepEqual(ctx.calls.published, [['created', logged]])
	assert.deepEqual(ctx.calls.setAlarm, [])
})

test('a fire the script refuses announces nothing, and re-arms the intent still pending', async () => {
	// Refused means this fire is not the pending intent: a newer schedule
	// replaced it mid-fire, or it is the second fire of one schedule. The
	// room's alarm was consumed by this fire either way, so a pending intent
	// is armed again here rather than left for the next visitor to arm.
	// Due after the refused fire, and before it: the pending one is armed
	// either way.
	for (const pendingAt of [NOW + 60_000, NOW - 60_000]) {
		const redis = memoryRedis()
		redis.evalReply = [0, JSON.stringify({ at: pendingAt, setAt: NOW - 90_000 })]
		const ctx = alarmCtx({ at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false })
		await recordFire(client(redis), ctx)
		assert.deepEqual(ctx.calls.published, [], String(pendingAt))
		assert.deepEqual(ctx.calls.setAlarm, [pendingAt], String(pendingAt))
	}
})

test('a refused fire with no usable intent left arms nothing', async () => {
	for (const intent of [null, '{not json', '{"at":"soon"}']) {
		const redis = memoryRedis()
		redis.evalReply = [0, intent]
		const ctx = alarmCtx({ at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false })
		await recordFire(client(redis), ctx)
		assert.deepEqual(ctx.calls.published, [], String(intent))
		assert.deepEqual(ctx.calls.setAlarm, [], String(intent))
	}
})

test('the stream loader arms the recorded alarm and draws the 24-hour line on the real clock', async () => {
	// A minute either side of the line, so a loader clock that is off by more
	// than that - a cutoff passed as now, seconds for milliseconds - lands one
	// of them on the wrong side.
	const redis = memoryRedis()
	const now = Date.now()
	const inside = fired('inside', RETENTION_MS - 60_000, now)
	redis.lists.set(LOG_KEY, [inside, fired('past', RETENTION_MS + 60_000, now)])
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: now + 30_000, setAt: now }))
	const ctx = streamCtx()

	const rows = await loadRoom(client(redis), ctx, TOPIC)

	assert.deepEqual(ctx.calls.setAlarm, [now + 30_000])
	assert.equal(ctx.calls.deleteAlarm, 0)
	assert.deepEqual(rows.map((row) => row.id), ['inside'])
	assert.deepEqual(redis.lists.get(LOG_KEY), [inside])
	assert.deepEqual(ctx.calls.published, [[TOPIC, 'deleted', { id: 'past' }]], 'the removal must go to the stream the open tabs subscribe to')
})

test('a Redis failure while reading the intent leaves the armed alarm alone', async () => {
	// Cancelling on a failed read would delete the durable alarm row, turning a
	// blip into a lost alarm.
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000, Date.now())])
	redis.failing.add('get')
	const ctx = streamCtx()
	assert.equal((await loadRoom(client(redis), ctx, TOPIC)).length, 1)
	assert.deepEqual(ctx.calls.setAlarm, [])
	assert.equal(ctx.calls.deleteAlarm, 0)
})

test('a Redis failure while reading the log fails the load rather than returning an empty one', async () => {
	// An empty result from a re-run is broadcast to every subscriber as the
	// new state, which would blank the log on every open tab.
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000, Date.now())])
	redis.failing.add('lrange')
	await assert.rejects(loadRoom(client(redis), streamCtx(), TOPIC), /lrange/)
})

test('a prune that fails to commit announces no deletions', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000, Date.now()), fired('old', 2 * RETENTION_MS, Date.now())])
	redis.failing.add('exec')
	const ctx = streamCtx()
	await loadRoom(client(redis), ctx, TOPIC).catch(() => {})
	assert.deepEqual(ctx.calls.published, [])
})

test('a read with nothing to prune writes nothing', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000)])
	await readLog(client(redis), NOW)
	assert.equal(redis.multis, 0)
	assert.equal(redis.ttl.has(LOG_KEY), false)
})

test('a fire that fails to persist is not announced and keeps its intent', async () => {
	// The intent is how a lost fire gets another chance: the next loader run
	// re-arms a past fire time to fire as soon as possible. The script clears
	// it only in the step that records the fire, so nothing else may.
	const redis = memoryRedis()
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: NOW, setAt: NOW - 60_000 }))
	redis.failing.add('eval')
	const ctx = alarmCtx({ at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false })
	await assert.rejects(recordFire(client(redis), ctx), /connection lost/)
	assert.deepEqual(ctx.calls.published, [])
	assert.deepEqual(ctx.calls.setAlarm, [])
	assert.equal(redis.strings.has(PENDING_KEY), true)
})

test('every fire gets its own id', async () => {
	// The stream merges by id, so two fires sharing one would collapse into a
	// single row on every open tab.
	const redis = memoryRedis()
	const alarm = { at: NOW - 3, firedAt: NOW, lateMs: 3, recovered: false }
	await recordFire(client(redis), alarmCtx(alarm))
	await recordFire(client(redis), alarmCtx(alarm))
	const ids = redis.evals.map(({ argv }) => JSON.parse(argv[0]).id)
	assert.equal(new Set(ids).size, 2)
})

test('a fractional delay reaches Redis as whole milliseconds, not whole seconds', async () => {
	for (const [seconds, ms] of [[2.5, 2_500], [2.0004, 2_000], [2.0006, 2_001]]) {
		const redis = memoryRedis()
		const at = await schedulePending(client(redis), seconds)
		assert.equal(redis.ttl.get(PENDING_KEY), ms + RETENTION_MS, `${seconds}s`)
		assert.equal(at - (await readPending(client(redis))).setAt, ms, `${seconds}s`)
	}
})

test('the stream loader clears the alarm when no intent is recorded, and a refused alarm still returns the log', async () => {
	const redis = memoryRedis()
	redis.lists.set(LOG_KEY, [fired('young', 1_000, Date.now())])
	const idle = streamCtx()
	assert.equal((await loadRoom(client(redis), idle, TOPIC)).length, 1)
	assert.equal(idle.calls.deleteAlarm, 1)

	const unbound = { ...streamCtx(), deleteAlarm() { throw new Error('not bound on this path') } }
	assert.equal((await loadRoom(client(redis), unbound, TOPIC)).length, 1)

	redis.strings.set(PENDING_KEY, JSON.stringify({ at: Date.now() + 5_000, setAt: Date.now() }))
	const refusing = { ...streamCtx(), setAlarm() { throw new Error('not bound on this path') } }
	assert.equal((await loadRoom(client(redis), refusing, TOPIC)).length, 1)
})

test('a failed write surfaces to the caller instead of reporting success', async () => {
	// schedule answers the visitor with the fire time and cancel answers ok;
	// either one swallowing a Redis failure would claim a state that is not there.
	const redis = memoryRedis()
	redis.failing.add('set')
	await assert.rejects(schedulePending(client(redis), 5), /set/)
	redis.failing.clear()
	redis.strings.set(PENDING_KEY, JSON.stringify({ at: NOW, setAt: NOW }))
	redis.failing.add('del')
	await assert.rejects(clearPending(client(redis)), /del/)
	assert.equal(redis.strings.has(PENDING_KEY), true)
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

	// Read Redis directly the moment clearPending resolves: a command sent
	// after it would queue behind an unawaited DEL and hide the missing await.
	await clearPending(client(redis))
	assert.equal(redis.strings.has(PENDING_KEY), false)
	assert.equal(await readPending(client(redis)), null)
})

test('an intent without a usable fire time reads as none', async () => {
	const redis = memoryRedis()
	for (const raw of ['{not json', '{"at":"soon"}', '{"at":null}', '{"at":1e999}', '{}']) {
		redis.strings.set(PENDING_KEY, raw)
		assert.equal(await readPending(client(redis)), null, raw)
	}
})
