import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithAdvisoryLock } from '../../src/lib/server/advisory-lock.js'

function fakePool(query) {
	const releases = []
	return {
		releases,
		client: {
			query,
			release(error) { releases.push(error) }
		},
		async connect() { return this.client }
	}
}

test('advisory lock acquire and release use one checked-out client', async () => {
	const calls = []
	const pool = fakePool(async (sql, params) => {
		calls.push([sql, params])
		if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
		return { rows: [{ released: true }] }
	})

	let callbackClient
	const value = await runWithAdvisoryLock(pool, 42, async (client) => {
		callbackClient = client
		return 'done'
	})
	assert.equal(value, 'done')
	assert.equal(callbackClient, pool.client)
	assert.equal(calls.length, 2)
	assert.deepEqual(calls.map((call) => call[1]), [[42], [42]])
	assert.deepEqual(pool.releases, [undefined])
})

test('unavailable advisory lock skips callback and still releases client once', async () => {
	const pool = fakePool(async () => ({ rows: [{ acquired: false }] }))
	let called = false

	const value = await runWithAdvisoryLock(pool, 7, async () => { called = true })
	assert.equal(value, undefined)
	assert.equal(called, false)
	assert.deepEqual(pool.releases, [undefined])
})

test('callback error is preserved when unlock also fails', async () => {
	const callbackError = Object.assign(new Error('critical failed'), { code: 'CRITICAL' })
	const unlockError = Object.assign(new Error('connection lost'), { code: '57P01' })
	let queryCount = 0
	const pool = fakePool(async () => {
		queryCount++
		if (queryCount === 1) return { rows: [{ acquired: true }] }
		throw unlockError
	})
	const logged = []
	const logger = { warn() {}, error(...args) { logged.push(args) } }

	await assert.rejects(
		runWithAdvisoryLock(pool, 9, async () => { throw callbackError }, logger),
		(err) => err === callbackError
	)
	assert.deepEqual(pool.releases, [unlockError])
	assert.equal(logged.length, 1)
})

test('unlock failure discards client and rejects successful callback', async () => {
	const unlockError = Object.assign(new Error('connection lost'), { code: '57P01' })
	let queryCount = 0
	const pool = fakePool(async () => {
		queryCount++
		if (queryCount === 1) return { rows: [{ acquired: true }] }
		throw unlockError
	})

	await assert.rejects(runWithAdvisoryLock(pool, 10, async () => 'done'), (err) => err === unlockError)
	assert.deepEqual(pool.releases, [unlockError])
})
