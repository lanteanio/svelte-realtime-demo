import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requireSubscribeHooks } from '../../src/lib/server/subscribe-hooks.js'

test('a realtime() result without both subscribe hooks stops startup and names the fix', () => {
	const fn = () => {}
	for (const config of [undefined, null, {}, { subscribe: fn }, { subscribeBatch: fn }, { subscribe: fn, subscribeBatch: 'x' }]) {
		assert.throws(() => requireSubscribeHooks(config), (/** @type {Error} */ error) => {
			assert.match(error.message, /no subscribe hooks/)
			assert.match(error.message, /npm ci/)
			assert.match(error.message, /0\.6\.0-next\.92/)
			return true
		})
	}
})

test('both hooks present are returned unchanged', () => {
	const subscribe = () => {}
	const subscribeBatch = () => {}
	const config = { subscribe, subscribeBatch, open: () => {} }
	assert.deepEqual(requireSubscribeHooks(config), { subscribe, subscribeBatch })
	assert.equal(requireSubscribeHooks({ subscribe, subscribeBatch }).subscribe, subscribe)
})
