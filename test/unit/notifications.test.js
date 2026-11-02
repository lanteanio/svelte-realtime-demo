import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseAst } from 'vite'

async function handlers() {
	const calls = { activity: [], published: [], failures: [], lookups: [] }
	let pushResult = { ack: 'ok' }
	let pushError
	class LiveError extends Error { constructor(code, message) { super(message); this.code = code } }
	const live = Object.assign(handler => handler, {
		stream: (_topic, handler) => handler,
		cron: (_schedule, _topic, handler) => handler,
		push: async () => { if (pushError) throw pushError; return pushResult }
	})
	const deps = {
		live, LiveError,
		TOPICS: { demoNotificationsScheduled: 'scheduled', demoNotificationsActivity: 'activity' },
		leader: { instanceId: 'worker-one' },
		registry: { instanceId: 'worker-one', lookup: async id => { calls.lookups.push(id); return { instanceId: 'worker-one' } } },
		metrics: { counter: () => ({ inc: value => calls.failures.push(value) }) },
		redis: { redis: { multi: () => {
			const pipeline = {
				lpush: (_key, raw) => { calls.activity.push(JSON.parse(raw)); return pipeline },
				lrange: () => pipeline, ltrim: () => pipeline,
				exec: async () => [[null, 1], [null, []], [null, 'OK']]
			}
			return pipeline
		} } }
	}
	let source = readFileSync(new URL('../../src/live/demos/notifications.js', import.meta.url), 'utf8')
	for (const item of (/** @type {any} */ (parseAst(source))).body.filter(node => node.type === 'ImportDeclaration').reverse()) {
		source = source.slice(0, item.start) + source.slice(item.end)
	}
	const key = `notificationTest_${crypto.randomUUID()}`
	globalThis[key] = deps
	let module
	try {
		module = await import('data:text/javascript;base64,' + Buffer.from(`const {${Object.keys(deps).join(',')}} = globalThis[${JSON.stringify(key)}]\n${source}`).toString('base64'))
	} finally { delete globalThis[key] }
	return {
		module, calls, LiveError,
		failPush: error => { pushError = error },
		dismiss: () => { pushResult = { ack: 'dismiss' } },
		ctx: { user: { id: 'a1111111-1111-4111-8111-111111111111', name: 'Visitor', color: '#888888' }, publish: (...args) => calls.published.push(args) },
		args: { recipientId: 'b2222222-2222-4222-8222-222222222222', recipientName: 'Recipient', text: 'Hello', scheduleSec: 0 }
	}
}

test('notification delivery retains useful success and dismissal outcomes', async () => {
	const h = await handlers()
	assert.deepEqual(await h.module.sendNotification(h.ctx, h.args), { ok: true, ack: 'ok', via: 'local', toInstance: 'worker-o' })
	h.dismiss()
	assert.equal((await h.module.sendNotification(h.ctx, h.args)).ack, 'dismiss')
	assert.deepEqual(h.calls.activity.map(entry => entry.kind), ['delivered', 'dismissed'])
	assert.deepEqual(h.calls.failures, [])
})

test('notification failures never return or publish backend text', async () => {
	for (const makeError of [h => new Error('redis://private-host/secret-token'), h => new h.LiveError('INTERNAL', 'private transport detail')]) {
		const h = await handlers()
		h.failPush(makeError(h))
		const result = await h.module.sendNotification(h.ctx, h.args)
		assert.deepEqual(result, { ok: false, kind: 'error', code: 'DELIVERY_FAILED', error: 'Notification could not be delivered', via: 'local', toInstance: 'worker-o' })
		assert.equal(h.calls.activity[0].error, result.error)
		assert.equal(h.calls.activity[0].code, result.code)
		assert.doesNotMatch(JSON.stringify([result, h.calls]), /private|redis:|secret-token/)
		assert.deepEqual(h.calls.failures, [{ outcome: 'error' }])
	}
})

test('known notification failures use stable allowlisted outcomes', async () => {
	for (const [code, kind, message] of [['NOT_FOUND', 'offline', 'Recipient is offline'], ['TIMEOUT', 'timeout', 'Notification timed out']]) {
		const h = await handlers()
		h.failPush(new h.LiveError(code, 'private diagnostic'))
		const result = await h.module.sendNotification(h.ctx, h.args)
		assert.equal(result.kind, kind)
		assert.equal(result.error, message)
		assert.equal(h.calls.activity[0].error, message)
		assert.deepEqual(h.calls.failures, [{ outcome: kind }])
	}
})
