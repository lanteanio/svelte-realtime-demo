import assert from 'node:assert/strict'
import test from 'node:test'
import { applyWireFrame, createWireRecord, formatDeliverySince, formatWire, markDelivery, streamTopic } from '../e2e/wire-report.js'

// The verdict this report reaches decides where someone looks next, and its
// four interesting states have four different owners: a request never sent is
// the client, one never answered is the server, one refused is authorization,
// and one answered is the page. Two of those cannot be produced from a browser
// without mocking the socket - and mocking it is exactly the arrangement the
// report refuses to speak for - so they are exercised here against records
// built by hand. Every case also asserts the verdicts it must NOT reach, since
// a classifier that is confident about everything discriminates nothing.

function record(overrides = {}) {
	return {
		routed: false,
		sockets: 1,
		sawHandshake: true,
		rpcs: [],
		overflowed: false,
		deliveries: new Map(),
		controls: new Map(),
		refusals: [],
		binaryIn: 0,
		orphanReplies: 0,
		...overrides
	}
}

function stream(rpc, extra = {}) {
	return { rpc, id: rpc.slice(-4), stream: true, at: 100, ...extra }
}

const answered = { replyAt: 140, ok: true, topic: 'demos:x', rows: 3 }

const VERDICTS = ['SOCKET ROUTED', 'NO EVIDENCE', 'NEVER ASKED', 'ASKED, NEVER ANSWERED', 'REFUSED', 'PARTLY ANSWERED', 'SUBSCRIPTION SUCCEEDED']

/** Assert the report reaches exactly one verdict, and that it is this one. */
function onlyVerdict(report, expected) {
	assert.ok(report.includes(expected), `expected ${expected} in:\n${report}`)
	for (const other of VERDICTS) {
		if (other === expected) continue
		assert.ok(!report.includes(other), `${expected} report also claimed ${other}:\n${report}`)
	}
}

test('an intercepted socket is never spoken for, however complete the frames look', () => {
	const report = formatWire(record({ routed: true, rpcs: [stream('demos/a/list', answered)] }))
	onlyVerdict(report, 'SOCKET ROUTED')
})

test('a record that saw no socket accuses no one', () => {
	onlyVerdict(formatWire(record({ sockets: 0 })), 'NO EVIDENCE')
})

test('a page that sent no stream request is told apart from one whose answer never came', () => {
	const report = formatWire(record({ rpcs: [{ rpc: 'demos/a/settings', id: 'q1', stream: false, at: 90, replyAt: 95, ok: true }] }))
	onlyVerdict(report, 'NEVER ASKED')
	// The other calls matter: a page that sent nothing at all and one that sent
	// everything except its subscribe are different bugs.
	assert.ok(report.includes('1 other call(s)'), report)
})

test('requests that went out and never came back say so', () => {
	const report = formatWire(record({ rpcs: [stream('demos/a/list'), stream('demos/a/feed')] }))
	onlyVerdict(report, 'ASKED, NEVER ANSWERED')
	assert.ok(report.includes('2 stream request(s)'), report)
	assert.ok(report.includes('NO REPLY'), report)
})

test('a refusal is named with the code and message the server gave', () => {
	const report = formatWire(record({
		rpcs: [stream('demos/a/list', { replyAt: 120, ok: false, code: 'FORBIDDEN', error: 'not your tenant' })]
	}))
	onlyVerdict(report, 'REFUSED')
	assert.ok(report.includes('FORBIDDEN'), report)
	assert.ok(report.includes('not your tenant'), report)
})

test('a partial answer names the request still outstanding', () => {
	const report = formatWire(record({ rpcs: [stream('demos/a/list', answered), stream('demos/a/feed')] }))
	onlyVerdict(report, 'PARTLY ANSWERED')
	assert.ok(report.includes('demos/a/feed'), report)
})

test('an answered subscription puts the fault above the transport, with its rows', () => {
	const report = formatWire(record({ rpcs: [stream('demos/a/list', answered), stream('demos/a/feed', { ...answered, rows: 2 })] }))
	onlyVerdict(report, 'SUBSCRIPTION SUCCEEDED')
	assert.ok(report.includes('5 row(s)'), report)
})

test('the stream filter is what makes the verdict about the wait that failed', () => {
	// One stream answered, one not. Unfiltered the report can only say the page
	// got SOME of what it asked for, which is true of a page rendering nothing.
	// Filtered to the stream the wait depended on, it names the failure.
	const mixed = record({ rpcs: [stream('demos/a/list', answered), stream('demos/a/feed')] })
	onlyVerdict(formatWire(mixed), 'PARTLY ANSWERED')
	onlyVerdict(formatWire(mixed, { stream: 'demos/a/feed' }), 'ASKED, NEVER ANSWERED')
	onlyVerdict(formatWire(mixed, { stream: 'demos/a/list' }), 'SUBSCRIPTION SUCCEEDED')
})

test('a filter matching nothing names what was requested instead of reporting a finding', () => {
	const report = formatWire(record({ rpcs: [stream('demos/a/list', answered)] }), { stream: 'demos/a/typo' })
	onlyVerdict(report, 'NEVER ASKED')
	assert.ok(report.includes('streams that WERE requested'), report)
	assert.ok(report.includes('demos/a/list'), report)
})

test('a record that began mid-connection says so rather than presenting a gap as a fact', () => {
	const late = formatWire(record({ sawHandshake: false, rpcs: [stream('demos/a/list', answered)] }))
	assert.ok(late.includes('PARTIAL RECORD'), late)

	const orphaned = formatWire(record({ orphanReplies: 2, rpcs: [stream('demos/a/list', answered)] }))
	assert.ok(orphaned.includes('PARTIAL RECORD'), orphaned)
	assert.ok(orphaned.includes('2 reply(ies)'), orphaned)

	// And a complete record does not carry the caveat, or it would be noise
	// everywhere and evidence nowhere.
	assert.ok(!formatWire(record({ rpcs: [stream('demos/a/list', answered)] })).includes('PARTIAL RECORD'))
})

test('a truncated call list says it is truncated', () => {
	const report = formatWire(record({ overflowed: true, rpcs: [stream('demos/a/list', answered)] }))
	assert.ok(report.includes('capped, list truncated'), report)
})

test('deliveries, refusals and control frames reach the report', () => {
	const report = formatWire(record({
		rpcs: [stream('demos/a/list', answered)],
		deliveries: new Map([['demos:x', { count: 4, first: 200, last: 900 }]]),
		refusals: [{ at: 210, frame: '{"type":"subscribe-denied","topic":"demos:x","reason":"capability"}' }],
		controls: new Map([['welcome', 1]])
	}))
	assert.ok(report.includes('demos:x x4 (200ms..900ms)'), report)
	assert.ok(report.includes('subscribe-denied'), report)
	assert.ok(report.includes('welcome x1'), report)
})

test('no record at all is stated, not rendered as an empty one', () => {
	const report = formatWire(null)
	assert.ok(report.includes('no wire record'), report)
	for (const verdict of VERDICTS) assert.ok(!report.includes(verdict), report)
})

// The accounting half, exercised with the frame shapes a live page actually
// sends. A record is only as good as what it counts, and one of these -
// a live update wrapped in a batch envelope - was miscounted until a probe
// printed the real frame: the topic went to the control tally and the
// deliveries table stayed empty on a page whose updates were flowing.

function fold(frames) {
	const built = createWireRecord()
	built.sockets = 1
	let at = 100
	for (const [direction, msg] of frames) applyWireFrame(built, direction, msg, at += 10)
	return built
}

test('a batch of stream requests is recorded as one call each', () => {
	const built = fold([['out', { batch: [
		{ rpc: 'demos/a/list', id: 'a1', args: [], stream: true },
		{ rpc: 'demos/a/feed', id: 'a2', args: [], stream: true }
	] }]])
	assert.equal(built.rpcs.length, 2)
	assert.deepEqual(built.rpcs.map((call) => call.rpc), ['demos/a/list', 'demos/a/feed'])
	assert.ok(built.rpcs.every((call) => call.stream))
})

test('a reply carries its rows and topic back to the request that is waiting', () => {
	const built = fold([
		['out', { rpc: 'demos/a/list', id: 'a1', args: [], stream: true }],
		['in', { topic: '__rpc', event: 'a1', data: { id: 'a1', ok: true, data: [1, 2, 3], topic: 'demos:a', merge: 'crud' } }]
	])
	assert.equal(built.rpcs[0].ok, true)
	assert.equal(built.rpcs[0].rows, 3)
	assert.equal(built.rpcs[0].topic, 'demos:a')
	assert.equal(built.orphanReplies, 0)
})

test('a batched reply correlates every entry, not only the first', () => {
	const built = fold([
		['out', { batch: [{ rpc: 'demos/a/list', id: 'a1', stream: true }, { rpc: 'demos/a/feed', id: 'a2', stream: true }] }],
		['in', { topic: '__rpc', event: '__batch', data: { batch: [
			{ id: 'a1', ok: true, data: [1], topic: 'demos:a' },
			{ id: 'a2', ok: false, code: 'FORBIDDEN', error: 'no' }
		] } }]
	])
	assert.equal(built.rpcs[0].ok, true)
	assert.equal(built.rpcs[1].ok, false)
	assert.equal(built.rpcs[1].code, 'FORBIDDEN')
})

test('a live update inside a batch envelope counts against its topic', () => {
	const built = fold([['in', { type: 'batch', events: [
		{ topic: 'demos:flash-sales:sales', event: 'created', data: { id: 's1' } },
		{ topic: 'demos:flash-sales:products', event: 'updated', data: { id: 'phone' } }
	] }]])
	// The evidence that a subscription is still delivering after its initial
	// payload. Counted only from inside the envelope, so a reader that stops at
	// the envelope reports both of these topics as silent.
	assert.equal(built.deliveries.get('demos:flash-sales:sales')?.count, 1)
	assert.equal(built.deliveries.get('demos:flash-sales:products')?.count, 1)
	assert.equal(built.controls.get('batch'), 1)
})

test('a bare topic frame counts too, and repeats keep first and last sight', () => {
	const built = fold([
		['in', { topic: '__presence:global', event: 'state', data: {} }],
		['in', { topic: '__presence:global', event: 'diff', data: {} }]
	])
	const seen = built.deliveries.get('__presence:global')
	assert.equal(seen.count, 2)
	assert.ok(seen.last > seen.first)
})

test('only inbound frames that cannot be read count as binary', () => {
	const built = fold([['in', null], ['in', null], ['out', null]])
	assert.equal(built.binaryIn, 2)
})

test('a reply with no request on record is counted as such, never dropped', () => {
	const built = fold([['in', { topic: '__rpc', event: 'zz', data: { id: 'zz', ok: true, data: [] } }]])
	assert.equal(built.orphanReplies, 1)
	assert.ok(formatWire(built).includes('PARTIAL RECORD'))
})

test('the handshake is what proves the record starts at the beginning', () => {
	assert.equal(fold([['out', { type: 'proto', v: 1 }]]).sawHandshake, true)
	assert.equal(fold([['out', { type: 'hello', caps: [] }]]).sawHandshake, true)
	assert.equal(fold([['out', { rpc: 'demos/a/list', id: 'a1', stream: true }]]).sawHandshake, false)
})

test('a refusal frame is kept whole, since the reason is the finding', () => {
	const built = fold([['in', { type: 'subscribe-denied', topic: 'demos:a', reason: 'capability' }]])
	assert.equal(built.refusals.length, 1)
	assert.ok(built.refusals[0].frame.includes('capability'))
})

test('past the cap the list stops growing and says that it stopped', () => {
	const many = Array.from({ length: 70 }, (unused, index) => ['out', { rpc: `demos/a/s${index}`, id: `i${index}`, stream: true }])
	const built = fold(many)
	assert.equal(built.rpcs.length, 64)
	assert.equal(built.overflowed, true)
	assert.ok(formatWire(built).includes('capped, list truncated'))
})

test('a control frame that names a topic is not counted as traffic on it', () => {
	// Both of these carry a topic and no payload for it. Counted as deliveries
	// they manufacture evidence that a silent subscription is delivering, which
	// is the opposite of what the report exists to establish.
	const built = fold([
		['in', { type: 'wire-id', topic: '__presence:demos:a', id: 2 }],
		['in', { type: 'subscribe-denied', topic: 'demos:a', reason: 'capability' }]
	])
	assert.equal(built.deliveries.size, 0)
	assert.equal(built.controls.get('wire-id'), 1)
	assert.equal(built.refusals.length, 1)
})

// The delivery report, for the other failure this evidence answers: a write the
// server ACCEPTED whose live view never moved. Acceptance is already proven by
// the time it is asked, so the two owners left are a publish that never
// happened and a published value that did not contain the change - and only the
// frames tell those apart. The verdicts lead the report, so they are asserted
// from the start of the string: "NEVER PUBLISHED" contains "PUBLISHED", and a
// substring check would call every silence a delivery.

const DELIVERY_VERDICTS = ['SOCKET ROUTED', 'NO EVIDENCE', 'TOPIC UNKNOWN', 'NEVER PUBLISHED', 'PUBLISHED']

function onlyDeliveryVerdict(report, expected) {
	assert.ok(report.startsWith(expected + ':'), `expected ${expected} to lead:\n${report}`)
	for (const other of DELIVERY_VERDICTS) {
		if (other === expected) continue
		assert.ok(!report.startsWith(other + ':'), `${expected} report led with ${other}:\n${report}`)
	}
}

const bound = { replyAt: 140, ok: true, topic: 'demos:privacy:agg-raw:round' }

test('the topic comes from the reply, so a rename cannot leave the test asserting a dead name', () => {
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	assert.equal(streamTopic(built, 'rawMood'), 'demos:privacy:agg-raw:round')
	assert.equal(streamTopic(built, 'privateMood'), null)
	// An unanswered stream named no topic, so it cannot supply one either.
	assert.equal(streamTopic(record({ rpcs: [stream('demos/privacy/rawMood/__window/round')] }), 'rawMood'), null)
})

test('a mark captures the count standing at the moment the action begins', () => {
	const built = record({
		rpcs: [stream('demos/privacy/rawMood/__window/round', bound)],
		deliveries: new Map([['demos:privacy:agg-raw:round', { count: 3, first: 10, last: 90 }]])
	})
	assert.deepEqual(markDelivery(built, 'rawMood'), { stream: 'rawMood', topic: 'demos:privacy:agg-raw:round', count: 3 })
	// No topic means no count either. A zero here would read as "nothing has
	// arrived" about a topic the record cannot even name.
	assert.deepEqual(markDelivery(built, 'nothingLikeThis'), { stream: 'nothingLikeThis', topic: null, count: null })
})

test('silence after the mark is reported as a publish that never happened', () => {
	const built = record({
		rpcs: [stream('demos/privacy/rawMood/__window/round', bound)],
		deliveries: new Map([['demos:privacy:agg-raw:round', { count: 1, first: 10, last: 90 }]])
	})
	const mark = markDelivery(built, 'rawMood')
	onlyDeliveryVerdict(formatDeliverySince(built, mark), 'NEVER PUBLISHED')
	// The frame that arrived BEFORE the mark is named, because "one frame, at
	// boot" and "no frame at all" are different states of the same topic.
	assert.ok(formatDeliverySince(built, mark).includes('1 frame(s) arrived before the mark'))
})

test('a topic that never delivered at all says so in its own words', () => {
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	const report = formatDeliverySince(built, markDelivery(built, 'rawMood'))
	onlyDeliveryVerdict(report, 'NEVER PUBLISHED')
	assert.ok(report.includes('nothing has ever arrived on it'), report)
})

test('a delivery after the mark is reported with what it carried', () => {
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	const mark = markDelivery(built, 'rawMood')
	built.deliveries.set('demos:privacy:agg-raw:round', { count: 2, first: 100, last: 340, lastData: { sum: 2, n: 1, avg: 2 } })
	const report = formatDeliverySince(built, mark)
	onlyDeliveryVerdict(report, 'PUBLISHED')
	assert.ok(report.includes('2 frame(s)'), report)
	// The payload is the whole point: an n that did not move is the reducer,
	// an n that did move is the page.
	assert.ok(report.includes('"n":1'), report)
})

test('a stream the record cannot name is refused, with the ones it can', () => {
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	const report = formatDeliverySince(built, markDelivery(built, 'privateMood'))
	onlyDeliveryVerdict(report, 'TOPIC UNKNOWN')
	assert.ok(report.includes('demos/privacy/rawMood/__window/round -> demos:privacy:agg-raw:round'), report)
})

test('the delivery report refuses an intercepted socket and a blind record alike', () => {
	const routed = record({ routed: true, rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	onlyDeliveryVerdict(formatDeliverySince(routed, markDelivery(routed, 'rawMood')), 'SOCKET ROUTED')

	const blind = record({ sockets: 0, rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	onlyDeliveryVerdict(formatDeliverySince(blind, markDelivery(blind, 'rawMood')), 'NO EVIDENCE')
})

test('the newest payload is what is kept, from a bare frame and from an envelope alike', () => {
	const bare = fold([
		['in', { topic: 'demos:privacy:agg-raw:round', event: 'set', data: { sum: 2, n: 1, avg: 2 } }],
		['in', { topic: 'demos:privacy:agg-raw:round', event: 'set', data: { sum: 7, n: 2, avg: 3.5 } }]
	])
	assert.deepEqual(bare.deliveries.get('demos:privacy:agg-raw:round').lastData, { sum: 7, n: 2, avg: 3.5 })

	const wrapped = fold([['in', { type: 'batch', events: [{ topic: 'demos:x', event: 'created', data: { id: 's1' } }] }]])
	assert.deepEqual(wrapped.deliveries.get('demos:x').lastData, { id: 's1' })
})

test('a reconnect leaves an unanswered request first, and the answered one still names the topic', () => {
	// The order matters and is reachable: a request left hanging by a dropped
	// socket stays in the record, and the resubscribe that follows is the one
	// that was answered. Taking the first match by name would resolve to the
	// stale request, which names no topic, and the report would then refuse to
	// answer a question it has the evidence for.
	const built = record({
		rpcs: [
			stream('demos/privacy/rawMood/__window/round'),
			stream('demos/privacy/rawMood/__window/round', { ...bound, id: 'again' })
		]
	})
	assert.equal(streamTopic(built, 'rawMood'), 'demos:privacy:agg-raw:round')
})
