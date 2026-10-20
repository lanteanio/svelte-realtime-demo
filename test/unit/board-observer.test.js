import assert from 'node:assert/strict'
import test from 'node:test'
import { live, realtime, unsubscribe } from 'svelte-realtime/server'
import { createTestEnv } from 'svelte-realtime/testing'
import { boardStreams, BOARD_ID } from '../helpers/board-observer.js'

/** @param {import('node:test').TestContext} t @param {(...args: any[]) => Promise<any>} [sync] */
function harness(t, sync = async () => {}) {
	realtime({ tenant: (user) => user?.tenant ?? null })
	const env = createTestEnv()
	env.platform.unsubscribe = (ws, topic) => { ws.unsubscribe(topic); unsubscribe(ws, topic, { platform: env.platform }) }
	const calls = { granted: [], released: [], lookedUp: [] }
	const presence = {
		async sync(ws, topic, platform) {
			assert.equal(ws.isSubscribed(topic), true, 'the managed grant precedes the snapshot')
			calls.granted.push({ ws, topic })
			return sync(ws, topic, platform)
		},
		join() { assert.fail('an observer must not join the roster') },
		leave() { assert.fail('observer cleanup must not remove a participant') },
		hooks: { unsubscribe: async (_ws, topic) => { calls.released.push(topic) } }
	}
	const streams = boardStreams(presence, {}, async (id) => {
		calls.lookedUp.push(id)
		return id === BOARD_ID ? { board_id: id } : null
	})
	env.register('observer', streams)
	t.after(() => { env.cleanup(); realtime({ tenant: null }) })
	return { env, calls }
}

test('board observers receive the granted wire topic and clean up their observer role', async (t) => {
	const h = harness(t)
	for (const tenant of [null, 'acme']) {
		const visitor = h.env.connect({ id: 'visitor', tenant })
		const stream = visitor.subscribe('observer/observeBoard', BOARD_ID)
		const expected = `${tenant ? `@t/${tenant}/` : ''}board:${BOARD_ID}`
		assert.deepEqual(await stream.waitFor((value) => value?.topic), { topic: expected })
		assert.equal(h.calls.granted.at(-1).topic, expected)
		visitor.disconnect()
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(h.calls.released.at(-1), `__presence:${expected}`)
	}
})

test('invalid and nonexistent boards receive no observation grant', async (t) => {
	const h = harness(t)
	const visitor = h.env.connect({ id: 'visitor' })
	for (const id of ['not-a-board', '12345678-1234-1234-1234-123456789def']) {
		const stream = visitor.subscribe('observer/observeBoard', id)
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(stream.error?.code, id === 'not-a-board' ? 'VALIDATION' : 'FORBIDDEN')
	}
	assert.deepEqual(h.calls.lookedUp, ['12345678-1234-1234-1234-123456789def'])
	assert.deepEqual(h.calls.granted, [])
	visitor.disconnect()
})

test('a refused presence snapshot rejects observation and releases its grant', async (t) => {
	const h = harness(t, async () => 'FORBIDDEN')
	const visitor = h.env.connect({ id: 'visitor' })
	const stream = visitor.subscribe('observer/observeBoard', BOARD_ID)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(stream.error?.code, 'FORBIDDEN')
	const { ws, topic } = h.calls.granted[0]
	assert.equal(ws.isSubscribed(topic), false)
	assert.deepEqual(h.calls.released, [`__presence:${topic}`])
	visitor.disconnect()
})

test('board participation is shed before acquiring any role under background pressure', async (t) => {
	const h = harness(t)
	live.admission({ classes: { background: ['MEMORY'] } })
	t.after(() => live.admission(null))
	h.env.platform.pressure = { reason: 'MEMORY' }
	const visitor = h.env.connect({ id: 'visitor' })
	const stream = visitor.subscribe('observer/participateBoard', BOARD_ID)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(stream.error?.code, 'OVERLOADED')
	assert.deepEqual(h.calls.granted, [])
	visitor.disconnect()
})
