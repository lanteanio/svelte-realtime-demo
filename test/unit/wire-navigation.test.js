import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { watchWire, formatWire } from '../e2e/helpers.js'

const stream = 'boards/notes/notes'
function fixture() {
	const page = new EventEmitter()
	const frame = { url: () => 'http://localhost/board/test' }
	page.mainFrame = () => frame
	const record = watchWire(page)
	const request = (owner = frame, navigation = true, previous = null) => ({
	 isNavigationRequest: () => navigation, frame: () => owner, redirectedFrom: () => previous,
	 url: () => 'http://localhost/board/test', resourceType: () => 'document', failure: () => ({ errorText: 'net::ERR_ABORTED' })
	})
	const socket = () => {
	 const ws = new EventEmitter()
	 ws.url = () => 'ws://localhost/ws'
	 page.emit('websocket', ws)
	 return { send: (id) => ws.emit('framesent', { payload: JSON.stringify({ rpc: stream, id, stream: true }) }),
	  reply: (id) => ws.emit('framereceived', { payload: JSON.stringify({ topic: '__rpc', event: id, data: { id, ok: true, data: [], topic: 'board:notes' } }) }) }
	}
	return { page, frame, record, request, socket, report: () => formatWire(record, { stream }) }
}

test('a document navigation excludes abandoned requests from the replacement document', () => {
	const h = fixture(); const old = h.socket(); old.send('old')
	h.page.emit('request', h.request())
	h.page.emit('framenavigated', h.frame)
	const fresh = h.socket(); fresh.send('fresh'); fresh.reply('fresh')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['fresh'])
	assert.equal(watchWire(h.page), h.record)
})

test('same-document reconnects retain genuinely unanswered requests', () => {
	const h = fixture(); h.socket().send('old')
	const fresh = h.socket(); fresh.send('fresh'); fresh.reply('fresh')
	assert.match(h.report(), /PARTLY ANSWERED:/)
	assert.equal(h.record.sockets, 2)
})

test('old-document frames cannot answer an equal request id on the current document', () => {
	const h = fixture(); const old = h.socket(); old.send('same')
	h.page.emit('request', h.request())
	h.page.emit('framenavigated', h.frame)
	h.socket().send('same'); old.reply('same')
	assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
	assert.equal(h.record.rpcs[0].replyAt, undefined)
})

test('SPA navigation, subframes and ordinary requests retain the same observation', () => {
	const h = fixture(); h.socket().send('pending')
	h.page.emit('framenavigated', h.frame)
	h.page.emit('request', h.request({}, true))
	h.page.emit('request', h.request(h.frame, false))
	assert.equal(h.record.rpcs.length, 1)
	assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
})

test('an aborted navigation preserves the live prior document and its intervening frames', () => {
	const h = fixture(); const old = h.socket(); old.send('pending')
	const req = h.request(); h.page.emit('request', req); old.reply('pending')
	h.page.emit('requestfailed', req)
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.equal(h.record.rpcs[0].id, 'pending')
})

test('redirects share one navigation and late failures cannot reset a newer document', () => {
	const h = fixture(); h.socket().send('old')
	const first = h.request(); h.page.emit('request', first)
	const redirect = h.request(h.frame, true, first); h.page.emit('request', redirect)
	h.page.emit('framenavigated', h.frame)
	const current = h.socket(); current.send('new'); current.reply('new')
	h.page.emit('requestfailed', first)
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.equal(h.record.rpcs[0].id, 'new')
	h.page.emit('requestfinished', redirect)
	h.page.emit('requestfailed', redirect)
	assert.equal(h.record.rpcs[0].id, 'new')
})


test('a no-content navigation response preserves the existing document', () => {
	const h = fixture(); h.socket().send('pending')
	const req = h.request(); h.page.emit('request', req)
	h.page.emit('response', { status: () => 204, request: () => req, url: req.url })
	h.page.emit('requestfinished', req)
	assert.match(h.report(), /ASKED, NEVER ANSWERED:/)
	assert.equal(h.record.rpcs[0].id, 'pending')
})


test('a committed document remains current when the next navigation fails before its body finishes', () => {
	const h = fixture(); h.socket().send('documentA')
	const first = h.request(); h.page.emit('request', first)
	h.page.emit('framenavigated', h.frame)
	h.socket().send('documentB')
	const next = h.request(); h.page.emit('request', next)
	h.page.emit('requestfailed', next)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['documentB'])
	h.page.emit('requestfailed', first)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['documentB'])
})

test('a reconnect before a failed document commit remains visible on the live document', () => {
	const h = fixture(); h.socket().send('original')
	const req = h.request(); h.page.emit('request', req)
	const reconnect = h.socket(); reconnect.send('retry'); reconnect.reply('retry')
	h.page.emit('requestfailed', req)
	assert.match(h.report(), /PARTLY ANSWERED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['original', 'retry'])
})

test('the retained current-document view serializes and updates routing state after navigation', () => {
	const h = fixture(); h.record.routed = true; h.socket().send('old')
	h.page.emit('request', h.request()); h.page.emit('framenavigated', h.frame)
	const socket = h.socket(); socket.send('new'); socket.reply('new')
	assert.equal(h.record.routed, false)
	assert.equal(JSON.parse(JSON.stringify(h.record)).rpcs[0].id, 'new')
	h.record.routed = true
	assert.match(h.report(), /SOCKET ROUTED:/)
})


test('a completed response body cannot erase the pending document commit', () => {
	const h = fixture(); h.socket().send('old')
	const req = h.request(); h.page.emit('request', req)
	h.page.emit('requestfinished', req)
	h.page.emit('framenavigated', h.frame)
	const socket = h.socket(); socket.send('new'); socket.reply('new')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
})

test('a document navigation with a fragment still establishes a new observation', () => {
	const h = fixture(); h.socket().send('old')
	h.page.emit('request', h.request())
	h.frame.url = () => 'http://localhost/board/test#section'
	h.page.emit('framenavigated', h.frame)
	const socket = h.socket(); socket.send('new'); socket.reply('new')
	assert.match(h.report(), /SUBSCRIPTION SUCCEEDED:/)
	assert.deepEqual(h.record.rpcs.map((r) => r.id), ['new'])
})
