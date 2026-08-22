/**
 * The subscription half of the wire: what a page asked for, and what came back.
 *
 * Separate from the capture in helpers.js because everything here is a pure
 * function of a record and a frame. Playwright supplies the frames; nothing in
 * this file needs a browser. That is what lets the states a page cannot easily
 * be driven into - a request the server never answers, one it refuses - be
 * exercised directly instead of being the only untested branches in the
 * diagnostic the rest of the suite leans on.
 *
 * The frame shapes below are measured off a live page, not read off the
 * adapter, and the delivery one is why this accounting is worth testing: live
 * updates arrive WRAPPED in a batch envelope, so a reader that only understands
 * the bare form counts none of them and reports a silent topic on a page whose
 * updates are flowing.
 *
 *   out {"rpc":"demos/flash-sales/productList","id":"a1","args":[],"stream":true}
 *   out {"batch":[{"rpc":"...","id":"a2","stream":true}, ...]}
 *   in  {"topic":"__rpc","event":"a1","data":{"id":"a1","ok":true,"data":[...],"topic":"demos:flash-sales:products"}}
 *   in  {"topic":"__rpc","event":"__batch","data":{"batch":[{"id":"a2","ok":true,...}]}}
 *   in  {"type":"batch","events":[{"topic":"demos:flash-sales:sales","event":"created","data":{...}}]}
 *   in  {"topic":"__presence:global","event":"diff","data":{...}}
 */

/**
 * How many RPC sends one record keeps.
 *
 * A page opening sends a handful; a serial spec that navigates repeatedly sends
 * many more, and a record is only ever read to explain ONE wait. The cap bounds
 * a long run and sets `overflowed`, so a truncated list says that it is
 * truncated instead of presenting its first entries as the whole history.
 */
const WIRE_RPC_CAP = 64;

/** A fresh record. Everything that follows only ever adds to one of these. */
export function createWireRecord() {
	return {
		routed: false,
		sockets: 0,
		sawHandshake: false,
		rpcs: [],
		overflowed: false,
		deliveries: new Map(),
		controls: new Map(),
		refusals: [],
		binaryIn: 0,
		orphanReplies: 0
	};
}

/** Correlate one reply with the request that is waiting for it. */
function applyReply(record, result, at) {
	if (!result || typeof result !== 'object') return;
	const entry = record.rpcs.find((r) => r.id === result.id);
	// A reply whose request is not in the list is not noise. It is proof that
	// this record began after that request went out, which is the one thing
	// that would turn a "never asked" verdict into a false accusation.
	if (!entry) {
		record.orphanReplies++;
		return;
	}
	entry.replyAt = at;
	entry.ok = result.ok === true;
	entry.code = result.code;
	entry.error = result.error;
	entry.topic = result.topic;
	entry.rows = Array.isArray(result.data) ? result.data.length : undefined;
}

/**
 * Count one delivery against its topic, keeping first and last sight of it and
 * what the last one carried.
 *
 * The payload is held by reference rather than serialised, so the cost is one
 * property write per frame however hot the topic, and only the newest object
 * per topic stays reachable. It is what separates a live view that never
 * received an update from one that received an update not containing the
 * change.
 */
function countDelivery(record, topic, at, data) {
	const seen = record.deliveries.get(topic) ?? { count: 0, first: at };
	seen.count++;
	seen.last = at;
	seen.lastData = data;
	record.deliveries.set(topic, seen);
}

/**
 * Fold one frame into a record.
 *
 * `msg` is the parsed JSON, or null for a frame that is not JSON at all. Those
 * carry the cursor and presence codecs, whose topic lives in an earlier wire-id
 * mapping: counted, never decoded, because this record exists to explain
 * streams and guessing at a payload it cannot read is the wrong kind of
 * confidence in a diagnostic.
 */
export function applyWireFrame(record, direction, msg, at) {
	if (!msg) {
		if (direction === 'in') record.binaryIn++;
		return;
	}
	if (direction === 'out') {
		if (msg.type === 'proto' || msg.type === 'hello') record.sawHandshake = true;
		const requests = Array.isArray(msg.batch) ? msg.batch : (msg.rpc ? [msg] : []);
		for (const request of requests) {
			if (record.rpcs.length >= WIRE_RPC_CAP) {
				record.overflowed = true;
				break;
			}
			record.rpcs.push({ rpc: request.rpc, id: request.id, stream: request.stream === true, at });
		}
		return;
	}
	if (msg.topic === '__rpc') {
		if (msg.event === '__batch') for (const result of msg.data?.batch ?? []) applyReply(record, result, at);
		else applyReply(record, msg.data, at);
		return;
	}
	if (typeof msg.type === 'string') {
		record.controls.set(msg.type, (record.controls.get(msg.type) ?? 0) + 1);
		// The envelope live updates travel in. Counted as the control frame it
		// is AND unwrapped, since the topics inside are the only evidence that
		// a subscription is still delivering after its initial payload.
		if (msg.type === 'batch' && Array.isArray(msg.events)) {
			for (const event of msg.events) {
				if (typeof event?.topic === 'string') countDelivery(record, event.topic, at, event.data);
			}
			return;
		}
		// A denial, a protocol error or a shed message explains a missing
		// subscription outright, so those are kept verbatim rather than reduced
		// to a count like the routine control traffic.
		if (msg.type === 'subscribe-denied' || msg.type === 'error' || msg.type === 'message-overloaded') {
			record.refusals.push({ at, frame: JSON.stringify(msg).slice(0, 300) });
		}
		return;
	}
	// Last, because several control frames NAME a topic without carrying data for
	// it - a wire-id mapping, a denial - and counting those as deliveries reports
	// traffic on a topic that has delivered nothing. A delivery is the frame with
	// no type at all.
	if (typeof msg.topic === 'string') {
		countDelivery(record, msg.topic, at, msg.data);
		return;
	}
}

/**
 * Turn the record into a verdict, not a table for the reader to interpret.
 *
 * Ordered so that the strongest disqualifier wins: a record that saw no socket
 * cannot accuse the page of anything, and an answered request rules out every
 * transport explanation rather than being one more line of evidence among many.
 */
function wireVerdict(record, selected, filter) {
	if (record.routed) {
		return 'SOCKET ROUTED: this spec intercepts the socket, so the frames below belong to the relay rather than to the page. A reply listed as answered may have been withheld from the page by the route handler, and nothing observable from outside can tell those apart. Read the calls as what the SERVER did.';
	}
	if (record.sockets === 0) {
		return 'NO EVIDENCE: this record saw no application socket, so it cannot say what the page asked for. Playwright reports frames only for sockets opened after the record is installed, so install it before the navigation rather than reading anything into the silence below.';
	}
	if (selected.length === 0) {
		const others = record.rpcs.length;
		const scope = filter ? `matching ${filter}` : 'at all';
		const also = others ? `, though it did send ${others} other call(s)` : '';
		return `NEVER ASKED: the page sent no stream request ${scope}${also}. The socket was open throughout, so this is the client never reaching its subscribe rather than the server failing to answer one.`;
	}
	const answered = selected.filter((r) => r.replyAt !== undefined);
	if (answered.length === 0) {
		return `ASKED, NEVER ANSWERED: ${selected.length} stream request(s) went out and not one came back. The socket stayed open, so the request reached a server that never replied to it.`;
	}
	const refused = answered.filter((r) => r.ok === false);
	if (refused.length) {
		const first = refused[0];
		return `REFUSED: the server answered ${first.rpc} with ${first.code ?? 'an error'} (${first.error ?? 'no message'}), so nothing was ever going to render.`;
	}
	if (answered.length < selected.length) {
		const missing = selected.filter((r) => r.replyAt === undefined).map((r) => r.rpc).join(', ');
		return `PARTLY ANSWERED: ${answered.length} of ${selected.length} stream request(s) came back. Unanswered: ${missing}.`;
	}
	const rows = answered.reduce((sum, r) => sum + (r.rows ?? 0), 0);
	return `SUBSCRIPTION SUCCEEDED: every stream request was answered, carrying ${rows} row(s) between them. The data reached the client, so the fault is above the transport - the page had what it needed and did not render it.`;
}

/**
 * Render a wire record for a failure message.
 *
 * `stream` narrows the verdict to the subscription the wait actually depended
 * on, by substring against the RPC name. A filter that matches nothing while
 * other streams were requested says so and names them, because "no such stream"
 * and "that stream was never requested" read identically otherwise and only one
 * of them is a finding about the page.
 *
 * @param {Record<string, any> | null} record
 * @param {{ stream?: string }} [options]
 */
export function formatWire(record, { stream } = {}) {
	if (!record) return 'no wire record was installed for this page';
	const streams = record.rpcs.filter((r) => r.stream);
	const selected = streams.filter((r) => !stream || String(r.rpc).includes(stream));
	const lines = [wireVerdict(record, selected, stream)];
	if (record.sockets > 0 && !record.sawHandshake) {
		lines.push('PARTIAL RECORD: no handshake frame was among those seen, so this record may begin mid-connection and every "never" above means "not since it began".');
	}
	if (record.orphanReplies) {
		lines.push(`PARTIAL RECORD: ${record.orphanReplies} reply(ies) arrived for calls this record never saw sent, so it began mid-connection.`);
	}
	if (stream && selected.length === 0 && streams.length) {
		lines.push(`streams that WERE requested: ${streams.map((r) => r.rpc).join(', ')}`);
	}
	lines.push(`sockets: ${record.sockets}, rpc sends: ${record.rpcs.length}${record.overflowed ? ' (capped, list truncated)' : ''}, binary frames in: ${record.binaryIn}`);
	if (record.rpcs.length) {
		lines.push('calls:');
		for (const call of record.rpcs) {
			const answer = call.replyAt === undefined
				? 'NO REPLY'
				: call.ok
					? `ok at ${call.replyAt}ms${call.topic ? ` topic=${call.topic}` : ''}${call.rows === undefined ? '' : ` rows=${call.rows}`}`
					: `FAILED at ${call.replyAt}ms ${call.code ?? ''} ${call.error ?? ''}`.trim();
			lines.push(`  ${call.stream ? 'stream' : '  call'} ${call.rpc} #${call.id} sent ${call.at}ms -> ${answer}`);
		}
	}
	if (record.deliveries.size) {
		lines.push('topic deliveries:');
		for (const [topic, seen] of record.deliveries) lines.push(`  ${topic} x${seen.count} (${seen.first}ms..${seen.last}ms)`);
	}
	if (record.refusals.length) {
		lines.push('refusals:');
		for (const refusal of record.refusals) lines.push(`  ${refusal.at}ms ${refusal.frame}`);
	}
	if (record.controls.size) {
		lines.push(`control frames: ${[...record.controls.entries()].map(([type, count]) => `${type} x${count}`).join(', ')}`);
	}
	return lines.join('\n');
}

/**
 * The topic a stream actually bound to, as the SERVER named it in its reply.
 *
 * Resolved rather than hard-coded on purpose. A test that knows the topic
 * string keeps passing after the topic is renamed, because it goes on asserting
 * about a name nothing publishes to any more; a test that reads the name out of
 * the reply fails the moment the two disagree. Null when no answered stream
 * matches, which callers must treat as "cannot say" and never as "silent".
 */
export function streamTopic(record, streamName) {
	const call = record?.rpcs?.find((r) => r.stream && r.topic && String(r.rpc).includes(streamName));
	return call?.topic ?? null;
}

/**
 * Take a mark on a stream's topic, to be read back after an action.
 *
 * The record counts deliveries cumulatively, so "did anything arrive because of
 * what I just did" is a difference and not a total. Everything the later report
 * needs is captured here, at the moment the action begins.
 */
export function markDelivery(record, streamName) {
	const topic = streamTopic(record, streamName);
	return { stream: streamName, topic, count: topic ? (record.deliveries.get(topic)?.count ?? 0) : null };
}

/**
 * Say whether a topic delivered anything since the mark, and what it carried.
 *
 * This is the report for the failure where a write was ACCEPTED and the live
 * view never moved. The acceptance is already proven by the time it is called,
 * so the two remaining owners are the publish that never happened and the value
 * that did arrive and did not contain the change - and those are told apart by
 * whether a frame exists at all, not by anything the page displays.
 */
export function formatDeliverySince(record, mark) {
	if (!record || !mark) return 'no wire record was installed for this page';
	if (record.routed) {
		return `SOCKET ROUTED: this spec intercepts the socket, so a delivery counted here may never have reached the page, and one missing here may only have been withheld by the route handler. Nothing about ${mark.stream} can be concluded from outside.`;
	}
	if (record.sockets === 0) {
		return 'NO EVIDENCE: this record saw no application socket, so it cannot say what was delivered. Playwright reports frames only for sockets opened after the record is installed.';
	}
	if (!mark.topic) {
		const named = record.rpcs.filter((r) => r.stream && r.topic).map((r) => `${r.rpc} -> ${r.topic}`);
		const alternatives = named.length ? `streams that DID name a topic: ${named.join(', ')}` : 'no stream reply named a topic at all';
		return `TOPIC UNKNOWN: no answered stream matching ${mark.stream} named a topic in its reply, so this cannot say whether anything was delivered. ${alternatives}.`;
	}
	const seen = record.deliveries.get(mark.topic);
	const now = seen?.count ?? 0;
	const delta = now - mark.count;
	if (delta <= 0) {
		const ever = now ? `${now} frame(s) arrived before the mark, the last at ${seen.last}ms` : 'nothing has ever arrived on it';
		return `NEVER PUBLISHED: no frame arrived on ${mark.topic} after the mark (${ever}). The write was accepted, so the gap is between accepting it and publishing the result, not in the client.`;
	}
	const carried = seen.lastData === undefined ? '(payload not recorded)' : JSON.stringify(seen.lastData).slice(0, 200);
	return `PUBLISHED: ${delta} frame(s) arrived on ${mark.topic} after the mark, the last at ${seen.last}ms carrying ${carried}. The publish happened, so what those frames carried - or the page applying it - is where this ends.`;
}
