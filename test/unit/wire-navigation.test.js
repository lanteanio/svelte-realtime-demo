import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { watchWire, formatWire } from '../e2e/helpers.js'

const stream = 'boards/notes/notes'
function fixture() {
	const frame = { url: () => 'http://localhost/board/test' }
	const page = Object.assign(new EventEmitter(), { mainFrame: () => frame })
	const record = watchWire(page)
	const request = (owner = frame, navigation = true, previous = null) => ({
		isNavigationRequest: () => navigation,
		frame: () => owner,
		redirectedFrom: () => previous,
		url: () => 'http://localhost/board/test',
		resourceType: () => 'document',
		failure: () => ({ errorText: 'net::ERR_ABORTED' })
	})
	const response = (req, status = 200) => page.emit('response', { status: () => status, request: () => req, url: req.url })
	const commit = (req = request()) => {
		page.emit('request', req)
		response(req)
		page.emit('framenavigated', frame)
	}
	const socket = () => {
		const ws = Object.assign(new EventEmitter(), { url: () => 'ws://localhost/ws' })
		page.emit('websocket', ws)
		return {
			send: (id) => ws.emit('framesent', { payload: JSON.stringify({ rpc: stream, id, stream: true }) }),
			reply: (id) => ws.emit('framereceived', { payload: JSON.stringify({ topic: '__rpc', event: id, data: { id, ok: true, data: [], topic: 'board:notes' } }) })
		}
	}
	return { page, frame, record, request, response, commit, socket, report: () => formatWire(record, { stream }) }
}

test('a response followed by document navigation excludes abandoned requests', () => {
	const h = fixture()
	h.socket().send('old')
	h.commit()
	const fresh = h.socket()
	fresh.send('fresh')
	fresh.reply('fresh')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['fresh'])
	assert.equal(watchWire(h.page), h.record)
})

test('same-document reconnects retain genuinely unanswered requests', () => {
	const h = fixture()
	h.socket().send('old')
	const fresh = h.socket()
	fresh.send('fresh')
	fresh.reply('fresh')
	assert.match(h.report(), /PARTLY ANSWERED:/)
	assert.equal(h.record.sockets, 2)
})

test('old-document frames cannot answer an equal request id on the current document', () => {
	const h = fixture()
	const old = h.socket()
	old.send('same')
	h.commit()
	h.socket().send('same')
	old.reply('same')
	assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
	assert.equal(h.record.rpcs[0].replyAt, undefined)
})

test('SPA navigation without a document request retains the observation', () => {
	const h = fixture()
	h.socket().send('pending')
	h.page.emit('framenavigated', h.frame)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['pending'])
})

for (const kind of ['subframe', 'ordinary']) {
	test(`${kind} requests and responses cannot qualify a main-frame history event`, () => {
		const h = fixture()
		h.socket().send('pending')
		const req = h.request(kind === 'subframe' ? { url: h.frame.url } : h.frame, kind !== 'ordinary')
		h.page.emit('request', req)
		h.response(req)
		h.page.emit('framenavigated', h.frame)
		assert.deepEqual(h.record.rpcs.map((r) => r.id), ['pending'])
		assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
	})
}

for (const fragment of ['', '#section']) {
	test(`same-URL history change before the document response preserves late old requests${fragment}`, () => {
		const h = fixture()
		h.socket().send('old')
		const req = h.request()
		h.page.emit('request', req)
		h.frame.url = () => `http://localhost/board/test${fragment}`
		h.page.emit('framenavigated', h.frame)
		h.socket().send('late-old')
		assert.deepEqual(h.record.rpcs.map((r) => r.id), ['old', 'late-old'])
		h.response(req)
		h.page.emit('framenavigated', h.frame)
		const fresh = h.socket()
		fresh.send('fresh')
		fresh.reply('fresh')
		assert.deepEqual(h.record.rpcs.map((r) => r.id), ['fresh'])
		assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	})
}

test('an aborted response-qualified navigation cannot rotate on a later history event', () => {
	const h = fixture()
	const old = h.socket()
	old.send('pending')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	old.reply('pending')
	h.page.emit('requestfailed', req)
	h.page.emit('framenavigated', h.frame)
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['pending'])
})

test('redirect response and late failure cannot erase the replacement request before commit', () => {
	const h = fixture()
	h.socket().send('old')
	const first = h.request()
	h.page.emit('request', first)
	h.response(first, 302)
	const redirect = h.request(h.frame, true, first)
	h.page.emit('request', redirect)
	h.response(redirect)
	h.page.emit('requestfailed', first)
	h.page.emit('framenavigated', h.frame)
	const current = h.socket()
	current.send('new')
	current.reply('new')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
	h.page.emit('requestfinished', redirect)
	h.page.emit('requestfailed', redirect)
	h.page.emit('framenavigated', h.frame)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
})

for (const status of [204, 205]) {
	test(`a ${status} response cannot qualify a later same-document navigation`, () => {
		const h = fixture()
		h.socket().send('pending')
		const req = h.request()
		h.page.emit('request', req)
		h.response(req, status)
		h.page.emit('requestfinished', req)
		h.page.emit('framenavigated', h.frame)
		assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
		assert.deepEqual(h.record.rpcs.map((r) => r.id), ['pending'])
	})
}

test('the response of a different request cannot qualify the pending document', () => {
	const h = fixture()
	h.socket().send('old')
	const old = h.request()
	h.page.emit('request', old)
	const pending = h.request()
	h.page.emit('request', pending)
	h.response(old)
	h.page.emit('framenavigated', h.frame)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['old'])
	h.response(pending)
	h.page.emit('framenavigated', h.frame)
	assert.equal(h.record.rpcs.length, 0)
})

test('a new request clears the response qualification of a superseded request', () => {
	const h = fixture()
	h.socket().send('old')
	const first = h.request()
	h.page.emit('request', first)
	h.response(first)
	const pending = h.request()
	h.page.emit('request', pending)
	h.page.emit('framenavigated', h.frame)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['old'])
	h.response(pending)
	h.page.emit('framenavigated', h.frame)
	assert.equal(h.record.rpcs.length, 0)
})

test('the response-qualified navigation must match the main-frame URL', () => {
	const h = fixture()
	h.socket().send('old')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	h.frame.url = () => 'http://localhost/different'
	h.page.emit('framenavigated', h.frame)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['old'])
	h.frame.url = req.url
	h.page.emit('framenavigated', h.frame)
	assert.equal(h.record.rpcs.length, 0)
})

test('a subframe commit cannot consume a response-qualified main-frame navigation', () => {
	const h = fixture()
	h.socket().send('old')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	h.page.emit('framenavigated', { url: req.url })
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['old'])
	h.page.emit('framenavigated', h.frame)
	assert.equal(h.record.rpcs.length, 0)
})

test('a committed document survives a later aborted response and stale first-request failure', () => {
	const h = fixture()
	h.socket().send('documentA')
	const first = h.request()
	h.commit(first)
	h.socket().send('documentB')
	const next = h.request()
	h.page.emit('request', next)
	h.response(next)
	h.page.emit('requestfailed', next)
	h.page.emit('framenavigated', h.frame)
	h.page.emit('requestfailed', first)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['documentB'])
})

test('a reconnect before an aborted commit remains visible after a history event', () => {
	const h = fixture()
	h.socket().send('original')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	const reconnect = h.socket()
	reconnect.send('retry')
	reconnect.reply('retry')
	h.page.emit('requestfailed', req)
	h.page.emit('framenavigated', h.frame)
	assert.match(h.report(), /PARTLY ANSWERED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['original', 'retry'])
})

test('the retained current-document view serializes and updates routing state after navigation', () => {
	const h = fixture()
	h.record.routed = true
	h.socket().send('old')
	h.commit()
	const socket = h.socket()
	socket.send('new')
	socket.reply('new')
	assert.equal(h.record.routed, false)
	assert.equal(JSON.parse(JSON.stringify(h.record)).rpcs[0].id, 'new')
	h.record.routed = true
	assert.match(h.report(), /SOCKET ROUTED:/)
})

test('a completed response body cannot erase the pending document commit', () => {
	const h = fixture()
	h.socket().send('old')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	h.page.emit('requestfinished', req)
	h.page.emit('framenavigated', h.frame)
	const socket = h.socket()
	socket.send('new')
	socket.reply('new')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
})

test('a document navigation with a fragment still establishes a new observation', () => {
	const h = fixture()
	h.socket().send('old')
	const req = h.request()
	h.page.emit('request', req)
	h.response(req)
	h.frame.url = () => 'http://localhost/board/test#section'
	h.page.emit('framenavigated', h.frame)
	const socket = h.socket()
	socket.send('new')
	socket.reply('new')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
})
