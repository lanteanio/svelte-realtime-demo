import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { flags, writes } from '../fixtures/handler-boundaries.js'

const fixture = new URL('../fixtures/handler-boundaries.js', import.meta.url).href
const aliases = {
	'svelte-realtime/server': fixture,
	'$lib/server/redis': fixture,
	'$lib/server/topics': new URL('../../src/lib/server/topics.js', import.meta.url).href
}
const hooks = registerHooks({ resolve(specifier, context, next) {
	return aliases[specifier] ? { url: aliases[specifier], shortCircuit: true } : next(specifier, context)
} })
let orders, featureFlags
try {
	orders = await import('../../src/live/demos/effect.js')
	featureFlags = await import('../../src/live/demos/flags.js')
} finally { hooks.deregister() }

const ctx = { user: { name: 'Visitor', color: '#112233' }, publish() {} }

test('orders persist finite totals for catalog products only', async () => {
	writes.length = 0
	const order = await orders.placeOrder(ctx, { productName: 'coffee', qty: 2 })
	assert.equal(order.total, 10)
	assert.equal(writes.length, 1)
	assert.equal(JSON.parse(writes[0].value).total, 10)
	for (const productName of ['missing', '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
		await assert.rejects(orders.placeOrder(ctx, { productName, qty: 2 }), { code: 'VALIDATION' })
	}
	assert.equal(writes.length, 1)
})

test('flags reject inherited and malformed names with validation errors', async () => {
	flags.length = 0
	await featureFlags.setFlag(ctx, 'banner', { enabled: true, text: 'Hello' })
	assert.deepEqual(flags, [{ enabled: true, text: 'Hello' }])
	for (const name of ['missing', '__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', null, {}, { toString: null }]) {
		await assert.rejects(featureFlags.setFlag(ctx, name, {}), { code: 'VALIDATION' })
	}
	assert.equal(flags.length, 1)
})
