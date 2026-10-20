import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bestEffort, forwardPluginFrame } from '../src/lib/server/hook-guard.js'

// Runs `run`, lets rejection handlers and unhandled-rejection detection fire,
// and returns what reached process 'unhandledRejection' and console.warn.
async function observe(run) {
	const unhandled = []
	const warnings = []
	const onUnhandled = (reason) => { unhandled.push(reason) }
	const warn = console.warn
	process.on('unhandledRejection', onUnhandled)
	console.warn = (...args) => { warnings.push(args) }
	try {
		run()
		await new Promise((resolve) => setImmediate(resolve))
		await new Promise((resolve) => setImmediate(resolve))
	} finally {
		process.off('unhandledRejection', onUnhandled)
		console.warn = warn
	}
	return { unhandled, warnings }
}

function failure(name, code) {
	const error = new Error(`${name} failure`)
	error.name = name
	if (code !== undefined) error.code = code
	return error
}

test('a rejected extension promise is handled and warned once per label and error code', async () => {
	const { unhandled, warnings } = await observe(() => {
		bestEffort('registry open', () => Promise.reject(failure('CircuitBrokenError', 'CIRCUIT_BROKEN')))
		bestEffort('registry open', () => Promise.reject(failure('CircuitBrokenError', 'CIRCUIT_BROKEN')))
		bestEffort('registry open', () => Promise.reject(failure('Error', 'ETIMEDOUT')))
	})
	assert.deepEqual(unhandled, [])
	assert.deepEqual(warnings, [
		['[realtime] registry open degraded', { name: 'CircuitBrokenError', code: 'CIRCUIT_BROKEN' }],
		['[realtime] registry open degraded', { name: 'Error', code: 'ETIMEDOUT' }]
	])
})

test('a synchronous throw is caught and warned', async () => {
	const { unhandled, warnings } = await observe(() => {
		bestEffort('cursor close', () => { throw failure('TypeError') })
	})
	assert.deepEqual(unhandled, [])
	assert.deepEqual(warnings, [['[realtime] cursor close degraded', { name: 'TypeError', code: undefined }]])
})

test('a WS_CLOSED rejection is handled without a warning', async () => {
	const { unhandled, warnings } = await observe(() => {
		bestEffort('global presence join', () => Promise.reject(failure('WsClosedError', 'WS_CLOSED')))
	})
	assert.deepEqual(unhandled, [])
	assert.deepEqual(warnings, [])
})

test('a thenable without catch gets its rejection reported with the original error', async () => {
	const thenable = { then(_resolve, reject) { reject(failure('RedisError', 'ECONNRESET')) } }
	const { warnings } = await observe(() => {
		bestEffort('bus open', () => thenable)
	})
	assert.deepEqual(warnings, [['[realtime] bus open degraded', { name: 'RedisError', code: 'ECONNRESET' }]])
})

test('a call returning a plain value runs once and is not warned', async () => {
	let calls = 0
	const { warnings } = await observe(() => {
		bestEffort('cursor subscribe', () => { calls++ })
		bestEffort('cursor subscribe', () => { calls++; return 0 })
	})
	assert.equal(calls, 2)
	assert.deepEqual(warnings, [])
})

test('the warning map drops its keys once it holds 256, so an old key warns again', async () => {
	const { warnings } = await observe(() => {
		bestEffort('bounded', () => { throw failure('Error', 'C0') })
		for (let i = 1; i <= 300; i++) bestEffort('bounded', () => { throw failure('Error', `C${i}`) })
		bestEffort('bounded', () => { throw failure('Error', 'C0') })
	})
	assert.equal(warnings.length, 302)
	assert.deepEqual(warnings.at(-1), ['[realtime] bounded degraded', { name: 'Error', code: 'C0' }])
})

// Mirrors the extension's cursor plugin: hooks.message starts the snapshot
// read for a `cursor-snapshot` frame and drops its promise.
function plugins(snapshotResult) {
	const calls = []
	const cursor = {
		snapshot(_ws, topic) {
			calls.push(['cursor.snapshot', topic])
			return snapshotResult()
		},
		hooks: {
			message(ws, { data, platform }) {
				calls.push(['cursor.hooks.message', data.type])
				if (data.type === 'cursor-snapshot' && typeof data.topic === 'string') cursor.snapshot(ws, data.topic, platform)
			}
		}
	}
	const presence = { hooks: { message(_ws, { data }) { calls.push(['presence.hooks.message', data.type]) } } }
	return { calls, cursor, presence }
}

test('a cursor snapshot request is routed through cursor.snapshot and its rejection is handled', async () => {
	const { calls, cursor, presence } = plugins(() => Promise.reject(failure('CircuitBrokenError', 'CIRCUIT_BROKEN')))
	const { unhandled, warnings } = await observe(() => {
		forwardPluginFrame({}, { type: 'cursor-snapshot', topic: 'board:1:presence' }, {}, cursor, presence)
	})
	assert.deepEqual(unhandled, [])
	assert.deepEqual(calls, [
		['cursor.snapshot', 'board:1:presence'],
		['presence.hooks.message', 'cursor-snapshot']
	])
	assert.deepEqual(warnings, [['[realtime] cursor snapshot degraded', { name: 'CircuitBrokenError', code: 'CIRCUIT_BROKEN' }]])
})

test('a cursor position frame goes straight to the cursor message hook', async () => {
	const { calls, cursor, presence } = plugins(() => Promise.resolve())
	const { warnings } = await observe(() => {
		forwardPluginFrame({}, { type: 'cursor', topic: 'board:1:presence', data: { x: 1, y: 2 } }, {}, cursor, presence)
	})
	assert.deepEqual(calls, [
		['cursor.hooks.message', 'cursor'],
		['presence.hooks.message', 'cursor']
	])
	assert.deepEqual(warnings, [])
})

test('a cursor snapshot frame without a string topic reaches only presence', async () => {
	const { calls, cursor, presence } = plugins(() => Promise.resolve())
	await observe(() => {
		forwardPluginFrame({}, { type: 'cursor-snapshot', topic: 7 }, {}, cursor, presence)
	})
	assert.deepEqual(calls, [['presence.hooks.message', 'cursor-snapshot']])
})
