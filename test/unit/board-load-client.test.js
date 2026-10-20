import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parseAst } from 'vite'
import { joinBoardWithRetry } from '../e2e/ws-rpc.js'

function socket(responses) {
	const ws = new EventEmitter()
	const sent = []
	Object.assign(ws, { send(message, callback) {
		const frame = JSON.parse(message)
		sent.push(frame)
		callback?.()
		const response = responses.shift()
		queueMicrotask(() => ws.emit('message', JSON.stringify({ topic: '__rpc', event: frame.id, data: response })))
	} })
	return { ws, sent }
}

test('load clients retain a managed participant and use its exact topic', async () => {
	const topic = '@t/acme/board:board-id'
	const peer = socket([{ ok: true, data: { topic } }])
	assert.equal(await joinBoardWithRetry(peer.ws, 'board-id'), topic)
	assert.equal(peer.sent[0].rpc, 'boards/cursors/participateBoard')
	assert.equal(peer.sent[0].stream, true)
	assert.deepEqual(peer.sent[0].args, ['board-id'])
})

test('load clients retry rejected admission but fail other errors', async () => {
	const topic = '@t/acme/board:board-id'
	const busy = socket([{ ok: false, code: 'OVERLOADED' }, { ok: true, data: { topic } }])
	assert.equal(await joinBoardWithRetry(busy.ws, 'board-id'), topic)
	assert.equal(busy.sent.length, 2)
	const denied = socket(Array.from({ length: 3 }, () => ({ ok: false, code: 'FORBIDDEN' })))
	await assert.rejects(joinBoardWithRetry(denied.ws, 'board-id'), /FORBIDDEN/)
	assert.equal(denied.sent.length, 1)
})

test('a successful reply without a canonical topic cannot start a load client', async () => {
	const peer = socket([{ ok: true, data: {} }])
	await assert.rejects(joinBoardWithRetry(peer.ws, 'board-id', { attempts: 1 }), /topic/)
})

for (const file of ['stress.spec.js', 'destroyer.spec.js', 'destroyer-standalone.js']) {
	test(`${file} sends adapter cursor frames on the acknowledged topic`, () => {
		const source = readFileSync(new URL(`../e2e/${file}`, import.meta.url), 'utf8')
		const name = file === 'destroyer-standalone.js' ? 'startCursor' : 'startCursorMovement'
		const declaration = (/** @type {any} */ (parseAst(source))).body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === name)
		const frames = []
		const ws = { readyState: 1, send: (message) => frames.push(JSON.parse(message)) }
		let interval
		const context = {
			WebSocket: { OPEN: 1 }, CURSOR_INTERVAL_MS: 32, nextId: () => 'legacy',
			setInterval: (callback) => { interval = callback; return 1 }
		}
		const start = vm.runInNewContext(`(${source.slice(declaration.start, declaration.end)})`, context)
		const topic = '@t/acme/board:board-id'
		start(file === 'destroyer-standalone.js' ? ws : { ws }, topic)
		interval()
		assert.equal(frames.length, 1)
		assert.equal(frames[0].type, 'cursor')
		assert.equal(frames[0].topic, topic)
		assert.ok(Number.isFinite(frames[0].data.x))
		assert.ok(Number.isFinite(frames[0].data.y))
		assert.equal(frames[0].rpc, undefined)
	})
}
