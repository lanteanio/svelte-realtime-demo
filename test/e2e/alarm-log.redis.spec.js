import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { createAlarmStore } from 'svelte-adapter-uws-extensions/redis/alarm-store'
import { configureAlarm, live, setCronPlatform } from 'svelte-realtime/server'
import * as realtimeServer from 'svelte-realtime/server'
import { createTestEnv } from 'svelte-realtime/testing'
import {
	clearPending, loadRoom, LOG_CAP, LOG_KEY, PENDING_KEY, readLog, readPending, recordFire, schedulePending
} from '../../src/lib/server/alarm-log.js'
import { RETENTION_MS } from '../../src/lib/server/alarm-retention.js'

// The alarms demo records a fire with one Lua script, and only a real Redis
// runs Lua, so this is where the script's effect on Redis is pinned. No page
// is involved. The harness's Redis is the one the app under test uses, so every
// key here goes through a per-run ioredis keyPrefix: nothing collides with the
// app's own alarm, and a script that reached a key by name instead of through
// KEYS would miss the prefixed keys these tests read back and fail them.
//
// Unit coverage of the same module, including what the handler does with each
// answer the script gives, is in test/unit/alarm-log.test.js.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const TOPIC = 'demos:alarms:log'

function redisURL() {
	const raw = process.env.REDIS_URL
	if (!raw) throw new Error('REDIS_URL is not set; the local e2e harness provides it')
	if (!LOOPBACK.has(new URL(raw).hostname)) throw new Error(`refusing to write to a non-loopback Redis: ${new URL(raw).host}`)
	return raw
}

// A remote target has no Redis this suite may write to. The local harness and
// CI always set LOCAL_E2E, so the gate never takes this skip.
test.skip(process.env.LOCAL_E2E !== '1', 'writes to the harness Redis, which only the local e2e harness provides')

/** @type {ReturnType<typeof createRedisClient>} */
let redis
/** @type {any} */
let client

test.beforeAll(() => {
	redis = createRedisClient({
		url: redisURL(),
		autoShutdown: false,
		options: { keyPrefix: `test:alarm-log:${randomUUID()}:` }
	})
	client = redis.redis
})

test.beforeEach(async () => {
	await client.del(LOG_KEY, PENDING_KEY)
})

test.afterAll(async () => {
	await client?.del(LOG_KEY, PENDING_KEY)
	await redis?.quit()
})

function streamCtx() {
	const calls = { setAlarm: [], deleteAlarm: 0, published: [] }
	return {
		calls,
		async setAlarm(at) { calls.setAlarm.push(at) },
		async deleteAlarm() { calls.deleteAlarm++ },
		publish(topic, event, data) { calls.published.push([topic, event, data]) }
	}
}

// A fire runs a little after its time, so firedAt never equals at and a
// script that matched the intent on the wrong field would be caught.
function alarmCtx(at) {
	const calls = { published: [], setAlarm: [] }
	const firedAt = Math.max(at, Date.now()) + 7
	return {
		calls,
		alarm: { at, firedAt, lateMs: firedAt - at, recovered: false },
		publish(event, data) { calls.published.push([event, data]) },
		async setAlarm(next) { calls.setAlarm.push(next) }
	}
}

const logged = async () => (await client.lrange(LOG_KEY, 0, -1)).map((raw) => JSON.parse(raw))

// The log's remaining TTL right after a fire set it: at most RETENTION_MS, and
// within a minute of it. RETENTION_MS handed to EXPIRE, as seconds, lands far
// above the ceiling, and a TTL longer than RETENTION_MS by more than the
// moments between the fire and this read lands above it; a TTL a millisecond
// longer can pass. One never set (-1), or left at the minute the first test
// seeds, is below the floor; one set less than a minute short of
// RETENTION_MS passes.
function expectRetentionTTL(pttl) {
	expect(pttl).toBeLessThanOrEqual(RETENTION_MS)
	expect(pttl).toBeGreaterThan(RETENTION_MS - 60_000)
}

test.describe('alarm log against a real Redis', () => {
	test('the recovery poll restores tenant scope from the durable alarm row', async () => {
		const env = createTestEnv()
		const store = createAlarmStore(redis, { keyPrefix: `recovery:${randomUUID()}:` })
		const wireTopic = `@t/acme/${TOPIC}`
		const path = 'alarmRecovery/timers'
		const keys = [LOG_KEY, PENDING_KEY, `${LOG_KEY}:tenant:acme`, `${PENDING_KEY}:tenant:acme`,
			`${LOG_KEY}:tenant:globex`, `${PENDING_KEY}:tenant:globex`]
		const callbacks = []
		const publications = []
		const publish = env.platform.publish.bind(env.platform)
		env.platform.publish = (topic, event, data, ...options) => {
			publications.push({ topic, event, data })
			return publish(topic, event, data, ...options)
		}
		env.register('alarmRecovery', {
			timers: live.stream(TOPIC, () => [], {
				alarm: { onAlarm: async (ctx) => {
					await recordFire(client, ctx)
					callbacks.push({ tenantId: ctx.tenantId, alarm: ctx.alarm })
				} }
			})
		})
		try {
			await client.del(...keys)
			const at = Date.now() - 1_500
			const publicIntent = { at: at + 60_000, setAt: at }
			const otherIntent = { at: at + 90_000, setAt: at }
			await client.set(PENDING_KEY, JSON.stringify(publicIntent), 'PX', RETENTION_MS)
			await client.set(`${PENDING_KEY}:tenant:globex`, JSON.stringify(otherIntent), 'PX', RETENTION_MS)
			await client.set(`${PENDING_KEY}:tenant:acme`, JSON.stringify({ at, setAt: at - 2_000 }), 'PX', RETENTION_MS)
			// No local timer or connected visitor exists. The persisted row is
			// the only input to the real recovery poll and callback resolver.
			const generation = await store.nextGeneration(wireTopic)
			await store.set(wireTopic, at, { path, tenantId: 'acme' }, generation)
			setCronPlatform(env.platform)
			configureAlarm({ store, leader: () => true, pollMs: 20 })
			await expect.poll(() => callbacks.length).toBe(1)
			expect(callbacks[0]).toMatchObject({ tenantId: 'acme', alarm: { at, recovered: true } })
			const records = await readLog(client, Date.now(), undefined, 'acme')
			expect(records).toHaveLength(1)
			expect(records[0]).toMatchObject({ at, recovered: true })
			expect(await readPending(client, 'acme')).toBeNull()
			expect(await readPending(client)).toEqual(publicIntent)
			expect(await readPending(client, 'globex')).toEqual(otherIntent)
			expect(await readLog(client, Date.now())).toEqual([])
			expect(await readLog(client, Date.now(), undefined, 'globex')).toEqual([])
			expect(publications.filter(({ event }) => event === 'created')).toEqual([
				{ topic: wireTopic, event: 'created', data: records[0] }
			])
			await expect.poll(() => store.getExecution(wireTopic, generation)).toBeNull()
			expect(await store.get(wireTopic)).toBeNull()
		} finally {
			configureAlarm(null)
			// The runtime-only helper clears any timer a failed assertion left.
			;(/** @type {any} */ (realtimeServer))._resetAlarms()
			setCronPlatform(null)
			env.cleanup()
			await store.clear()
			await store.destroy()
			await client.del(...keys)
		}
	})

	test('a rejected replacement alarm keeps the newer intent and fails the old callback', async () => {
		const at = await schedulePending(client, 30)
		const ctx = alarmCtx(at - 1_000)
		const rejection = Promise.reject(new Error('replacement refused'))
		rejection.catch(() => {})
		ctx.setAlarm = () => rejection

		await expect(recordFire(client, ctx)).rejects.toThrow('replacement refused')

		expect((await readPending(client)).at).toBe(at)
		expect(await logged()).toEqual([])
		expect(ctx.calls.published).toEqual([])
	})

	test('precise and recovered tenant fires leave other scopes intact', async () => {
		const scopes = [null, 'acme', 'globex', 'public']
		const keys = scopes.flatMap((scope) => scope === null
			? [LOG_KEY, PENDING_KEY]
			: [`${LOG_KEY}:tenant:${scope}`, `${PENDING_KEY}:tenant:${scope}`])
		try {
			for (const recovered of [false, true]) {
				await client.del(...keys)
				const times = []
				for (const [i, scope] of scopes.entries()) times.push(await schedulePending(client, 2 + i, scope))
				const ctx = { ...alarmCtx(times[1]), tenantId: 'acme' }
				ctx.alarm.recovered = recovered
				await recordFire(client, ctx)
				await recordFire(client, ctx)
				expect(await readPending(client, 'acme')).toBeNull()
				for (const i of [0, 2, 3]) expect((await readPending(client, scopes[i]))?.at).toBe(times[i])
				const room = { ...streamCtx(), tenantId: 'acme' }
				const records = await loadRoom(client, room, TOPIC)
				expect(records).toHaveLength(1)
				expect(records[0]).toMatchObject({ at: times[1], recovered })
				expect(ctx.calls.published).toHaveLength(1)
				for (const scope of [null, 'globex', 'public']) {
					expect(await loadRoom(client, { ...streamCtx(), tenantId: scope }, TOPIC)).toEqual([])
				}
				await clearPending(client, 'globex')
				expect(await readPending(client, 'globex')).toBeNull()
				expect((await readPending(client))?.at).toBe(times[0])
				expect((await readPending(client, 'public'))?.at).toBe(times[3])
			}
		} finally {
			await client.del(...keys)
		}
	})

	test('a fire of the pending schedule lands at the head, keeps LOG_CAP, refreshes the TTL, clears the intent and is announced', async () => {
		const now = Date.now()
		const older = Array.from({ length: LOG_CAP }, (_, i) =>
			JSON.stringify({ id: `r${i}`, at: now - (i + 1) * 1_000, firedAt: now - (i + 1) * 1_000, lateMs: 0, recovered: false }))
		await client.rpush(LOG_KEY, ...older)
		await client.pexpire(LOG_KEY, 60_000)
		const at = await schedulePending(client, 2)
		const ctx = alarmCtx(at)

		await recordFire(client, ctx)

		const log = await logged()
		expect(log).toHaveLength(LOG_CAP)
		expect(log[0]).toEqual({ ...ctx.alarm, id: log[0].id })
		expect(log[1].id).toBe('r0')
		expect(ctx.calls.published).toEqual([['created', log[0]]])
		expect(ctx.calls.setAlarm).toEqual([])
		// Refreshed from the minute it was seeded with.
		expectRetentionTTL(await client.pttl(LOG_KEY))
		expect(await client.exists(PENDING_KEY)).toBe(0)
	})

	test('the first fire on an empty log leaves it with a TTL', async () => {
		const at = await schedulePending(client, 2)
		await recordFire(client, alarmCtx(at))
		expect(await client.llen(LOG_KEY)).toBe(1)
		expectRetentionTTL(await client.pttl(LOG_KEY))
	})

	test('a schedule re-armed by a visitor who subscribed mid-fire is logged once', async () => {
		// A loader that reads the intent before the fire has recorded it
		// arms the same fire time again, and the room fires a second time.
		const at = await schedulePending(client, 2)
		const subscriber = streamCtx()
		await loadRoom(client, subscriber, TOPIC)
		expect(subscriber.calls.setAlarm).toEqual([at])

		const first = alarmCtx(at)
		const second = alarmCtx(at)
		await recordFire(client, first)
		await recordFire(client, second)

		expect((await logged()).map((record) => record.at)).toEqual([at])
		expect(first.calls.published).toHaveLength(1)
		expect(second.calls.published, 'the second fire must not reach the open tabs either').toEqual([])
		expect(second.calls.setAlarm).toEqual([])

		// And a loader after the fire has nothing left to arm.
		const later = streamCtx()
		await loadRoom(client, later, TOPIC)
		expect(later.calls.setAlarm).toEqual([])
		expect(later.calls.deleteAlarm).toBe(1)
	})

	test('a schedule made while an alarm is firing survives the fire, and stays armed', async () => {
		const firing = await schedulePending(client, 2)
		// The new schedule reaches Redis before the older fire is recorded, and
		// the visitor who made it has already been answered with its fire time.
		const acknowledged = await schedulePending(client, 60)
		expect(acknowledged).not.toBe(firing)
		const ctx = alarmCtx(firing)

		await recordFire(client, ctx)

		expect((await readPending(client))?.at).toBe(acknowledged)
		expect(await logged(), 'a fire its schedule no longer asks for is not logged').toEqual([])
		expect(ctx.calls.published).toEqual([])
		expect(ctx.calls.setAlarm, 'the fire consumed the room alarm, so it arms the pending one again').toEqual([acknowledged])

		const next = streamCtx()
		await loadRoom(client, next, TOPIC)
		expect(next.calls.setAlarm).toEqual([acknowledged])
		expect(next.calls.deleteAlarm).toBe(0)
	})

	test('a schedule made while an alarm is firing survives the fire when it is due sooner, too', async () => {
		// The same race with the newer schedule due BEFORE the one firing. An
		// intent is matched on equality, not on which fire time is later.
		const firing = await schedulePending(client, 60)
		const acknowledged = await schedulePending(client, 2)
		expect(acknowledged).toBeLessThan(firing)
		const ctx = alarmCtx(firing)

		await recordFire(client, ctx)

		expect((await readPending(client))?.at).toBe(acknowledged)
		expect(await logged()).toEqual([])
		expect(ctx.calls.published).toEqual([])
		expect(ctx.calls.setAlarm).toEqual([acknowledged])

		const next = streamCtx()
		await loadRoom(client, next, TOPIC)
		expect(next.calls.setAlarm).toEqual([acknowledged])
		expect(next.calls.deleteAlarm).toBe(0)
	})

	test('a replacement due 1 ms either side of the firing time is not taken for it', async () => {
		// The other replacements here are a minute or so from the fire. The
		// match is on the exact fire time, so one millisecond apart is already
		// another schedule.
		for (const offset of [1, -1]) {
			await client.del(LOG_KEY, PENDING_KEY)
			const firing = Date.now() + 2_000
			const acknowledged = firing + offset
			await client.set(PENDING_KEY, JSON.stringify({ at: acknowledged, setAt: Date.now() }), 'PX', 60_000)
			const ctx = alarmCtx(firing)

			await recordFire(client, ctx)

			expect((await readPending(client))?.at, String(offset)).toBe(acknowledged)
			expect(await logged(), String(offset)).toEqual([])
			expect(ctx.calls.published, String(offset)).toEqual([])
			expect(ctx.calls.setAlarm, String(offset)).toEqual([acknowledged])
		}
	})

	test('an alarm cancelled while it was firing logs nothing and arms nothing', async () => {
		const at = await schedulePending(client, 2)
		await clearPending(client)
		const ctx = alarmCtx(at)
		await recordFire(client, ctx)
		expect(await logged()).toEqual([])
		expect(ctx.calls.published).toEqual([])
		expect(ctx.calls.setAlarm).toEqual([])
	})

	test('an intent the script cannot read as a fire time refuses the fire and is left as it is', async () => {
		// Not JSON and JSON that is not an object are refused rather than
		// failing inside the script. An object with no `at`, a null one, or a
		// string one - even the fire's own time as a string - is refused too:
		// the loader reads no fire time from it either.
		const at = Date.now()
		for (const raw of ['{not json', '42', 'null', 'true', '"soon"', '{}', '{"at":null}', '{"at":"soon"}', `{"at":"${at}"}`]) {
			await client.set(PENDING_KEY, raw, 'PX', 60_000)
			const ctx = alarmCtx(at)
			await recordFire(client, ctx)
			expect(await logged(), raw).toEqual([])
			expect(await client.get(PENDING_KEY), raw).toBe(raw)
			expect(ctx.calls.setAlarm, raw).toEqual([])
		}
	})
})
