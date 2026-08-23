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

/**
 * A record with the raw-mood stream bound, some frames delivered before the
 * mark and the rest after it.
 *
 * Built by folding real frames rather than by writing the record's internals,
 * so these tests go on testing the report rather than the shape it happens to
 * keep its history in.
 */
function delivered(before, after) {
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	let at = 100
	const send = (data) => applyWireFrame(built, 'in', { topic: 'demos:privacy:agg-raw:round', event: 'set', data }, (at += 20))
	for (const data of before) send(data)
	const mark = markDelivery(built, 'rawMood')
	for (const data of after) send(data)
	return { report: formatDeliverySince(built, mark), built }
}

/** The payload lines of a report, which are the only indented ones. */
function listed(report) {
	return report.split('\n').filter((line) => line.startsWith('  '))
}

test('a delivery after the mark is reported with what it carried', () => {
	const { report } = delivered([], [{ sum: 6, n: 2, avg: 3 }, { sum: 2, n: 1, avg: 2 }])
	onlyDeliveryVerdict(report, 'PUBLISHED')
	assert.ok(report.includes('2 frame(s)'), report)
	// The payload is the whole point: an n that did not move is the reducer,
	// an n that did move is the page.
	assert.ok(report.includes('"n":1'), report)
})

test('the frames since the mark are all named, so a replaced value is not read as a missing one', () => {
	// The two shapes below present an IDENTICAL last frame - n back at 1 - and
	// have different owners: one is a value that never moved, the other a later
	// publish landing on top of an earlier one. Only the frame BEFORE the last
	// says which happened, so a report naming just the newest answers neither.
	const { report } = delivered([], [{ sum: 6, n: 2 }, { sum: 5, n: 1 }])
	const earlier = report.indexOf('{"sum":6,"n":2}')
	const later = report.indexOf('{"sum":5,"n":1}')
	assert.ok(earlier > -1, `the replaced value is missing from:\n${report}`)
	assert.ok(later > -1, `the surviving value is missing from:\n${report}`)
	// Oldest first. Reversed, the report would read as a count that grew.
	assert.ok(earlier < later, `the frames are listed newest first:\n${report}`)
	assert.ok(report.includes('CHANGED'), report)
	assert.ok(!report.includes('SAME'), `a sequence that moved was called unchanged:\n${report}`)

	const flat = delivered([], [{ sum: 5, n: 1 }, { sum: 5, n: 1 }]).report
	assert.ok(flat.includes('SAME'), flat)
	assert.ok(!flat.includes('CHANGED'), `a value that never moved was called changed:\n${flat}`)
})

test('a repeated payload collapses to one line, so identical frames are counted rather than listed', () => {
	const same = { sum: 5, n: 1 }
	const { report } = delivered([], [same, same, same, same])
	assert.ok(report.includes('{"sum":5,"n":1} x4'), report)
	// One line for the run, not four. The count is what carries the repetition,
	// and four identical lines would bury the distinction in what looks like
	// noise.
	assert.equal(listed(report).length, 1, report)
})

test('frames from before the mark are not listed among the ones the action caused', () => {
	const { report } = delivered([{ sum: 1, n: 1 }], [{ sum: 6, n: 2 }])
	assert.ok(report.includes('1 frame(s) arrived'), report)
	assert.ok(report.includes('{"sum":6,"n":2}'), report)
	// The boot frame is still held and belongs to no action. Listing it would
	// present a value the click never produced as one of its results.
	assert.equal(listed(report).length, 1, report)
	assert.ok(!report.includes('{"sum":1,"n":1}'), `a frame from before the mark was attributed to the action:\n${report}`)
})

test('a list that lost its oldest frames says so, and stops short of claiming the value never moved', () => {
	// Forty distinct frames against sixteen slots, so the report is holding a
	// tail and has to know that it is.
	const { report } = delivered([], Array.from({ length: 40 }, (_, i) => ({ sum: i, n: 1 })))
	assert.ok(report.includes('40 frame(s) arrived'), report)
	assert.ok(report.includes('24 oldest since the mark are no longer held'), report)
	assert.equal(listed(report).length, 16, report)
	// The tail is what is kept: the frames nearest the failure explain it, and
	// the earliest ones are the ones the ring gave up.
	assert.ok(report.includes('{"sum":39,"n":1}'), report)
	assert.ok(!report.includes('{"sum":23,"n":1}'), `a frame past the cap survived:\n${report}`)
	// Sixteen frames out of forty are no evidence about the other twenty-four,
	// and a report that spoke for them would be inventing what it never saw.
	assert.ok(!report.includes('Every frame since the mark'), `a truncated list spoke for frames it never held:\n${report}`)
})

test('a truncated list of identical frames refuses to speak for the ones it lost', () => {
	// Forty frames carrying the same value, sixteen slots. Every frame the
	// report can see is identical, and it still has not seen twenty-four of
	// them - so "the value never moved" is a claim it has not earned.
	const { report } = delivered([], Array.from({ length: 40 }, () => ({ sum: 5, n: 1 })))
	assert.ok(report.includes('24 oldest since the mark are no longer held'), report)
	assert.ok(report.includes('SAME'), report)
	assert.ok(report.includes('this cannot say the value never moved'), report)
	assert.ok(!report.includes('Every frame since the mark'), `a truncated list spoke for frames it never held:\n${report}`)
})

test('a wrapped ring is still listed in arrival order, so the value that won is the last one', () => {
	// Twenty frames against sixteen slots leaves the newest four written over
	// the oldest four, so the ring's slot order and arrival order disagree.
	// Listing by slot would rotate the sequence and name the wrong frame as the
	// one the page ended on - which is the whole conclusion this report exists
	// to support.
	const { report } = delivered([], Array.from({ length: 20 }, (_, i) => ({ sum: i, n: 1 })))
	const shown = listed(report)
	assert.equal(shown.length, 16, report)
	const order = shown.map((line) => Number(line.match(/"sum":(\d+)/)[1]))
	assert.deepEqual(order, Array.from({ length: 16 }, (_, i) => 4 + i), `the wrapped ring was listed out of order:\n${report}`)
	// Timestamps rise with the sequence, so a rotation shows up here too.
	const times = shown.map((line) => Number(line.match(/^ {2}(\d+)ms/)[1]))
	assert.deepEqual(times, [...times].sort((a, b) => a - b), `frame times are not ascending:\n${report}`)
})

test('a record holding no payload reports not knowing, rather than throwing inside the failure it explains', () => {
	// This report runs inside a catch that rewrites a real test failure. A
	// reporter that threw here would replace the failure someone needs to read
	// with a crash in the thing that was supposed to explain it.
	const built = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	const mark = markDelivery(built, 'rawMood')
	built.deliveries.set('demos:privacy:agg-raw:round', { count: 2, first: 100, last: 340 })
	const report = formatDeliverySince(built, mark)
	onlyDeliveryVerdict(report, 'PUBLISHED')
	assert.ok(report.includes('no payload was retained'), report)
	// The frames are still proven to exist by the count, so the report must not
	// resolve its own blindness into a claim about what they carried.
	assert.ok(!report.includes('SAME'), report)
	assert.ok(!report.includes('CHANGED'), report)
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

test('the payload sequence is what is kept, from a bare frame and from an envelope alike', () => {
	// Envelope frames are the ones live updates actually travel in, and a
	// reader that understood only the bare form would report a silent topic on
	// a page whose updates were flowing. Both forms must reach the sequence.
	const bare = record({ rpcs: [stream('demos/privacy/rawMood/__window/round', bound)] })
	bare.sockets = 1
	const mark = markDelivery(bare, 'rawMood')
	applyWireFrame(bare, 'in', { topic: 'demos:privacy:agg-raw:round', event: 'set', data: { sum: 2, n: 1, avg: 2 } }, 120)
	applyWireFrame(bare, 'in', { type: 'batch', events: [{ topic: 'demos:privacy:agg-raw:round', event: 'set', data: { sum: 7, n: 2, avg: 3.5 } }] }, 140)
	const report = formatDeliverySince(bare, mark)
	assert.ok(report.includes('{"sum":2,"n":1,"avg":2}'), report)
	assert.ok(report.includes('{"sum":7,"n":2,"avg":3.5}'), report)
	assert.equal(listed(report).length, 2, report)
})

test('a hot topic keeps its newest frames and no more, so the record cannot grow with the run', () => {
	// Deliberately about the representation, because the bound IS the point.
	// Payloads are held by reference: uncapped, a cursor topic would keep every
	// object it ever delivered reachable for as long as the record lives, which
	// measured 26 MiB over 200k frames on one topic.
	const hot = fold(Array.from({ length: 50 }, (_, i) => ['in', { topic: 'demos:x', event: 'moved', data: { i } }]))
	const seen = hot.deliveries.get('demos:x')
	assert.equal(seen.count, 50)
	assert.equal(seen.datas.length, 16)
	assert.equal(seen.datas.filter((d) => d !== undefined).length, 16)
	// The tail, not the head: the frames nearest the failure are the ones worth
	// keeping, and dropping the newest would leave the report explaining a
	// moment that had already passed.
	const kept = seen.datas.map((d) => d.i).sort((a, b) => a - b)
	assert.deepEqual(kept, Array.from({ length: 16 }, (_, i) => 34 + i))
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
