import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { CREATE_SESSION, REFRESH_SESSION } from '../../src/lib/server/session-admission.js'

if (!process.env.REDIS_TEST_URL) throw new Error('REDIS_TEST_URL must name an isolated test Redis')
const redis = createRedisClient({ url: process.env.REDIS_TEST_URL }).redis
const prefix = `session-test:${randomUUID()}:`
const keys = new Set()
after(async () => {
	if (keys.size) await redis.del(...keys)
	await redis.quit()
})

function admit(group, id, capacity, rate = 1000, ttl = 60) {
	const names = [`${prefix}${group}:session:${id}`, `${prefix}${group}:slots`, `${prefix}${group}:issuance`]
	names.forEach(key => keys.add(key))
	return redis.eval(CREATE_SESSION, 3, ...names, capacity, rate, ttl, id, randomUUID(), 'Visitor', '#112233', 'acme')
}

test('concurrent cookie-discarding requests cannot exceed session capacity', async () => {
	const outcomes = await Promise.all(Array.from({ length: 1000 }, (_, id) => admit('capacity', String(id), 10)))
	assert.equal(outcomes.filter(value => value === 1).length, 10)
	assert.equal(await redis.zcard(`${prefix}capacity:slots`), 10)
	assert.equal((await redis.keys(`${prefix}capacity:session:*`)).length, 10)
})

test('issuance is bounded independently of retained capacity', async () => {
	const outcomes = await Promise.all(Array.from({ length: 100 }, (_, id) => admit('rate', String(id), 1000, 3)))
	assert.equal(outcomes.filter(value => value === 1).length, 3)
	assert.equal(await redis.zcard(`${prefix}rate:slots`), 3)
})

test('refresh holds a capacity reservation and missing sessions cannot resurrect it', async () => {
	assert.equal(await admit('refresh', 'one', 1), 1)
	const session = `${prefix}refresh:session:one`
	const slots = `${prefix}refresh:slots`
	await redis.zadd(slots, 1, 'one')
	const values = await redis.eval(REFRESH_SESSION, 2, session, slots, 60, 'one', 1)
	assert.equal(Object.fromEntries(Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]])).name, 'Visitor')
	assert.ok(Number(await redis.zscore(slots, 'one')) > Date.now())
	assert.equal(await admit('refresh', 'two', 1), 0)
	await redis.del(session)
	assert.deepEqual(await redis.eval(REFRESH_SESSION, 2, session, slots, 60, 'one', 1), [])
	assert.equal(await redis.exists(session), 0)
	await redis.zadd(slots, 1, 'one')
	assert.equal(await admit('refresh', 'two', 1), 1)
})

test('old sessions require capacity before their lifetime can be extended', async () => {
	assert.equal(await admit('legacy', 'current', 1), 1)
	const old = `${prefix}legacy:session:old`
	keys.add(old)
	await redis.hset(old, { id: randomUUID(), name: 'Visitor', color: '#112233', org: 'acme' })
	await redis.expire(old, 30)
	assert.deepEqual(await redis.eval(REFRESH_SESSION, 2, old, `${prefix}legacy:slots`, 60, 'old', 1), [])
	assert.ok(await redis.ttl(old) <= 30)
	assert.equal(await redis.zcard(`${prefix}legacy:slots`), 1)
})
