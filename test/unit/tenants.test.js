import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEMO_TENANTS, isDemoTenant, publishToEveryScope } from '../../src/lib/server/tenants.js'

function recordingCtx() {
	const calls = []
	return {
		calls,
		publish: (...args) => { calls.push({ scope: null, args }) },
		tenant: (id) => ({ publish: (...args) => { calls.push({ scope: id, args }) } })
	}
}

test('a public event goes out unscoped and once into each tenant, with the same arguments', () => {
	const ctx = recordingCtx()
	const data = { id: 'evt-7', seq: 7 }
	const options = { seq: 7 }
	publishToEveryScope(ctx, 'demos:ticker', 'created', data, options)
	assert.deepEqual(ctx.calls.map((call) => call.scope), [null, 'acme', 'globex'])
	for (const call of ctx.calls) {
		assert.deepEqual(call.args, ['demos:ticker', 'created', data, options])
		assert.equal(call.args[3], options)
	}
})

test('an event without options keeps options undefined in every scope', () => {
	const ctx = recordingCtx()
	publishToEveryScope(ctx, 'demos:ticker', 'created', { id: 'evt-1' })
	assert.equal(ctx.calls.length, 1 + DEMO_TENANTS.length)
	for (const call of ctx.calls) assert.equal(call.args[3], undefined)
})

test('a context that carries a tenant is refused before anything is published', () => {
	for (const tenantId of ['acme', 'globex']) {
		const ctx = { ...recordingCtx(), tenantId }
		assert.throws(() => publishToEveryScope(ctx, 'demos:ticker', 'created', {}), /without a tenant/)
		assert.deepEqual(ctx.calls, [])
	}
	for (const tenantId of [null, undefined]) {
		const ctx = { ...recordingCtx(), tenantId }
		publishToEveryScope(ctx, 'demos:ticker', 'created', {})
		assert.equal(ctx.calls.length, 1 + DEMO_TENANTS.length)
	}
})

test('the tenant list is fixed and only its members are tenants', () => {
	assert.deepEqual([...DEMO_TENANTS], ['acme', 'globex'])
	assert.equal(Object.isFrozen(DEMO_TENANTS), true)
	for (const value of ['acme', 'globex']) assert.equal(isDemoTenant(value), true)
	for (const value of [null, undefined, '', 'ACME', 'initech', 'acme ', ['acme'], 1]) assert.equal(isDemoTenant(value), false)
})
