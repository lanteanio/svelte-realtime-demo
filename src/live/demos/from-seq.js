// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/from-seq: three-tier reconnect via delta.fromSeq.
 *
 * The pitch. A 1Hz cron publishes events on a topic, each with an
 * incrementing `seq`. The stream's loader returns the recent
 * window from a cluster-shared durable store and tags every entry
 * `tier: 'rehydrate'`. Live publishes (the cron) tag `tier: 'live'`.
 * `delta.fromSeq(sinceSeq)` is wired to the same durable store and
 * tags `tier: 'fromSeq'` on every event it returns. The page
 * renders all events with their tier as a badge, so you can see
 * which path delivered each one.
 *
 * Demo flow: the page subscribes; live events arrive tagged
 * `live`. Click Pause; the page unsubscribes from this stream
 * (subCount hits 0, SDK drops the subscription). The server's cron
 * keeps publishing; events are stored in the durable Redis hash. Click
 * Resume; the page re-subscribes, the SDK sends its cached
 * `_lastSeq` on the wire, and once the pause outruns the bounded replay
 * buffer the framework falls through to `delta.fromSeq`, which reads from
 * the durable hash and returns the missed entries tagged `fromSeq`.
 *
 * The headline primitive: `delta.fromSeq(sinceSeq)` - the
 * user-provided bridge for older-than-buffer reconnects, the third
 * tier of the reconnect resolution chain (replay buffer ->
 * fromSeq -> rehydrate via loader).
 *
 * Storage is cluster-shared via Redis (INCR counter + HASH keyed by
 * seq). The leader-gated cron is the only writer; every replica reads
 * the same view from its loader and delta.fromSeq paths.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const STORE_RETAIN = 200
const RECENT_WINDOW = 20

const PHRASES = [
	'session check-in',
	'cache warmup',
	'health probe',
	'metrics flush',
	'audit roll',
	'queue tick',
	'cleanup sweep'
]

const NEXT_SEQ_KEY = 'demos:fromseq:next'
const DURABLE_KEY = 'demos:fromseq:durable'
const FAST_NEXT_SEQ_KEY = 'demos:fromseq:fast:next'
const FAST_DURABLE_KEY = 'demos:fromseq:fast:durable'

async function getNextSeq(key = NEXT_SEQ_KEY) {
	const v = await redis.redis.get(key)
	if (v === null) return 0
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

async function pruneStore(currentSeq, key = DURABLE_KEY) {
	if (currentSeq <= STORE_RETAIN) return
	// The single publisher advances by one per tick, so exactly one field falls
	// out of the window each time. Deleting it directly keeps this O(1); an
	// HKEYS sweep would pull all ~200 retained field names off the wire every
	// second just to identify that one field.
	await redis.redis.hdel(key, String(currentSeq - STORE_RETAIN))
}

/**
 * True when this store can actually answer for `sinceSeq`.
 *
 * The cursor the framework hands `delta.fromSeq` is the replay extension's
 * protocol seq, while this store is indexed by the application counter the
 * cron increments. The single publisher advances both together, but they are
 * distinct Redis counters with different lifetimes - the protocol counter
 * carries the replay buffer's TTL, the application counter has none - so a
 * publish gap longer than that TTL restarts one and not the other. Rather
 * than return a confidently wrong slice, report a miss and let the framework
 * fall through to the loader, which is the reconnect ladder's honest last
 * tier. The same guard covers an ordinary pause that outruns STORE_RETAIN.
 */
function canAnswerFromSeq(sinceSeq, nextSeq) {
	if (sinceSeq > nextSeq) return false
	return sinceSeq >= nextSeq - STORE_RETAIN
}

async function readRange(startSeq, endSeq, key = DURABLE_KEY) {
	if (endSeq < startSeq) return []
	// `pruneStore` only ever retains the last STORE_RETAIN seqs, so a request
	// reaching further back can only yield nulls. Clamp instead of expanding
	// the field list: a resume cursor can lag the store arbitrarily far (a very
	// long pause, or a replay-buffer TTL expiry that restarts the wire seq
	// while the durable counter keeps climbing), and an unclamped range would
	// build one HMGET with tens of thousands of guaranteed-miss fields.
	const from = Math.max(startSeq, endSeq - STORE_RETAIN + 1)
	const fields = []
	for (let s = from; s <= endSeq; s++) fields.push(String(s))
	if (fields.length === 0) return []
	const values = await redis.redis.hmget(key, ...fields)
	const out = []
	for (const v of values) {
		if (v === null) continue
		try { out.push(JSON.parse(v)) } catch { /* skip corrupt */ }
	}
	return out
}

export const myFromSeqState = live(async () => ({
	storeRetain: STORE_RETAIN,
	recentWindow: RECENT_WINDOW
}))

/**
 * The headline. Cron tick at 1Hz publishes one event per tick. The
 * event is stored in the durable Redis hash AND broadcast as a live
 * publish. Stored events feed both the loader's recent-window
 * rehydrate and `delta.fromSeq`'s gap-fill on reconnect.
 *
 * INCR is atomic across replicas, so even though the cron is leader-
 * singleton (configureCron({ leader })) any handover to a new leader
 * resumes the same monotonic sequence without rebasing to zero.
 */
export const tickEvents = live.cron('* * * * * *', TOPICS.demoFromSeqEvents, async (ctx) => {
	const seq = await redis.redis.incr(NEXT_SEQ_KEY)
	const entry = {
		id: 'evt-' + seq,
		seq,
		ts: Date.now(),
		message: PHRASES[seq % PHRASES.length] + ' #' + seq,
		tier: 'live'
	}
	await redis.redis.hset(DURABLE_KEY, String(seq), JSON.stringify(entry))
	await pruneStore(seq)
	ctx.publish(TOPICS.demoFromSeqEvents, 'created', entry)

	// The accelerant has its own aligned durable sequence domain. That keeps
	// delta.fromSeq's application sequence equal to the replay protocol cursor
	// even when this topic is introduced into an already-running deployment.
	const fastSeq = await redis.redis.incr(FAST_NEXT_SEQ_KEY)
	const fastEntry = {
		id: 'fast-evt-' + fastSeq,
		seq: fastSeq,
		ts: entry.ts,
		message: PHRASES[fastSeq % PHRASES.length] + ' #' + fastSeq,
		tier: 'live'
	}
	await redis.redis.hset(FAST_DURABLE_KEY, String(fastSeq), JSON.stringify(fastEntry))
	await pruneStore(fastSeq, FAST_DURABLE_KEY)
	ctx.publish(TOPICS.demoFromSeqFastEvents, 'created', fastEntry)
})

/**
 * Stream with `delta.fromSeq`. The loader returns the recent window
 * (last RECENT_WINDOW entries) tagged `rehydrate`. On reconnect
 * with a stale `lastSeq`, the framework checks the replay buffer
 * first and falls through to `delta.fromSeq` once the gap outruns
 * it; the bridge reads the durable hash and returns the missed
 * entries tagged `fromSeq`.
 *
 * The bridge returns `{ event, data, seq }` envelopes, not bare rows:
 * a `replay: true` array response is fed straight into the client's
 * `_applyMerge`, which dispatches on `envelope.event`. Bare rows carry
 * no `event`, so they silently fail to merge.
 *
 * Live publishes from `tickEvents` arrive as 'created' events
 * tagged `live`; they merge into the existing list by id.
 */
async function loadRecentEvents() {
	const nextSeq = await getNextSeq()
	const startSeq = Math.max(1, nextSeq - RECENT_WINDOW + 1)
	const entries = await readRange(startSeq, nextSeq)
	return entries.map((e) => ({ ...e, tier: 'rehydrate' }))
}

async function loadEventsFromSeq(sinceSeq) {
	if (typeof sinceSeq !== 'number' || sinceSeq < 0) return null
	const nextSeq = await getNextSeq()
	if (!canAnswerFromSeq(sinceSeq, nextSeq)) return null
	const entries = await readRange(sinceSeq + 1, nextSeq)
	return entries.map((e) => ({
		event: 'created',
		data: { ...e, tier: 'fromSeq' },
		seq: e.seq
	}))
}

async function loadRecentFastEvents() {
	const nextSeq = await getNextSeq(FAST_NEXT_SEQ_KEY)
	const startSeq = Math.max(1, nextSeq - RECENT_WINDOW + 1)
	const entries = await readRange(startSeq, nextSeq, FAST_DURABLE_KEY)
	return entries.map((e) => ({ ...e, tier: 'rehydrate' }))
}

async function loadFastEventsFromSeq(sinceSeq) {
	if (typeof sinceSeq !== 'number' || sinceSeq < 0) return null
	const nextSeq = await getNextSeq(FAST_NEXT_SEQ_KEY)
	if (!canAnswerFromSeq(sinceSeq, nextSeq)) return null
	const entries = await readRange(sinceSeq + 1, nextSeq, FAST_DURABLE_KEY)
	return entries.map((e) => ({
		event: 'created',
		data: { ...e, tier: 'fromSeq' },
		seq: e.seq
	}))
}

export const eventStream = live.stream(
	TOPICS.demoFromSeqEvents,
	async () => loadRecentEvents(),
	{
		merge: 'crud',
		key: 'id',
		max: STORE_RETAIN,
		// `replay: true` opts this stream into the platform's bounded
		// replay buffer (configured in src/lib/server/redis.js). The
		// buffer covers gaps within its size (200 events at 1Hz =
		// roughly 3 minutes); for older gaps the framework falls
		// through to `delta.fromSeq` below. The flag also routes cron
		// publishes through `replay.publish` so they pick up the
		// wire-level seq numbers the resume cursor is expressed in.
		replay: true,
		delta: {
			fromSeq: loadEventsFromSeq
		}
	}
)

/**
 * Demo accelerant with a small, independent durable sequence domain. Its
 * adapter replay seam reports a buffer miss on resume, so realtime proceeds
 * through the real delta.fromSeq handler immediately. The normal eventStream
 * above remains the production three-tier ladder; visitors opt into this
 * stream only long enough to witness the named tier without a 200-second wait.
 */
export const eventStreamFast = live.stream(
	TOPICS.demoFromSeqFastEvents,
	async () => loadRecentFastEvents(),
	{
		merge: 'crud',
		key: 'id',
		max: STORE_RETAIN,
		replay: true,
		delta: {
			fromSeq: loadFastEventsFromSeq
		}
	}
)
