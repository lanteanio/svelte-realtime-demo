import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import {
	clearPending, loadRoom, LOG_CAP, LOG_KEY, PENDING_KEY, readPending, recordFire, schedulePending
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
		setAlarm(at) { calls.setAlarm.push(at) },
		deleteAlarm() { calls.deleteAlarm++ },
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
		setAlarm(next) { calls.setAlarm.push(next) }
	}
}

const logged = async () => (await client.lrange(LOG_KEY, 0, -1)).map((raw) => JSON.parse(raw))

// The log's remaining TTL right after a fire set it: at most RETENTION_MS, and
// within a minute of it. A TTL set in seconds, or set longer, is above the
// ceiling; one never set (-1), or left at a shorter value, is below the floor.
function expectRetentionTTL(pttl) {
	expect(pttl).toBeLessThanOrEqual(RETENTION_MS)
	expect(pttl).toBeGreaterThan(RETENTION_MS - 60_000)
}

test.describe('alarm log against a real Redis', () => {
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
		// failing inside the script. An object with no `at`, or with a string
		// one - even the fire's own time as a string - is refused too: the
		// loader reads no fire time from it either.
		const at = Date.now()
		for (const raw of ['{not json', '42', 'null', 'true', '"soon"', '{}', '{"at":"soon"}', `{"at":"${at}"}`]) {
			await client.set(PENDING_KEY, raw, 'PX', 60_000)
			const ctx = alarmCtx(at)
			await recordFire(client, ctx)
			expect(await logged(), raw).toEqual([])
			expect(await client.get(PENDING_KEY), raw).toBe(raw)
			expect(ctx.calls.setAlarm, raw).toEqual([])
		}
	})
})
