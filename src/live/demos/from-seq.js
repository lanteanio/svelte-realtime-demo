// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/from-seq: two reconnect ladders, a replay buffer and delta.fromSeq.
 *
 * A 1Hz cron publishes numbered events on two topics. Each stream's loader
 * returns the recent window from a cluster-shared durable store and tags
 * every entry `tier: 'rehydrate'`; live publishes tag `tier: 'live'`. The
 * page renders every event with its tier as a badge, so you can see which
 * path delivered it.
 *
 * Pause drops the subscription while the cron keeps publishing; Resume
 * subscribes again and the SDK sends the last seq it saw. What answers the
 * gap depends on the stream, because a stream resumes from a replay buffer
 * or through `delta.fromSeq`, never both:
 *
 * - `eventStream` declares `replay`. A gap the bounded buffer still covers
 *   is replayed; a longer one reloads the recent window through the loader.
 * - `eventStreamFast` declares `delta.fromSeq` and no buffer. Its cron
 *   publish stamps the application seq as the wire seq, so the cursor the
 *   client resumes from is the store's own index, and `delta.fromSeq` reads
 *   the missed entries from the durable hash tagged `fromSeq`. A gap older
 *   than the store reloads through the loader.
 *
 * Storage is cluster-shared via Redis (INCR counter + HASH keyed by seq).
 * The leader-gated cron is the only writer; every replica reads the same
 * view from its loader and delta.fromSeq paths.
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
 * The cursor `delta.fromSeq` receives is the seq the cron stamped on the
 * wire, which is this store's index. A cursor ahead of the counter (the
 * store was reset while a client kept its old cursor) or behind the retained
 * window has no honest answer here, so report a miss and let the framework
 * reload through the loader.
 */
function canAnswerFromSeq(sinceSeq, nextSeq) {
	if (sinceSeq > nextSeq) return false
	return sinceSeq >= nextSeq - STORE_RETAIN
}

async function readRange(startSeq, endSeq, key = DURABLE_KEY) {
	if (endSeq < startSeq) return []
	// `pruneStore` only ever retains the last STORE_RETAIN seqs, so a request
	// reaching further back can only yield nulls. Clamp instead of expanding
	// the field list: a resume cursor can lag the store arbitrarily far after
	// a very long pause, and an unclamped range would build one HMGET with
	// tens of thousands of guaranteed-miss fields.
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
 * publish. Stored events feed the loaders' recent-window rehydrate, and
 * the fromSeq stream's store also answers its `delta.fromSeq` gap-fill.
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

	// The fromSeq stream has no replay buffer, so the application counter is
	// the wire seq. One leader allocates and publishes each tick, in order.
	// The extensions bus carries the explicit seq to every replica and marks
	// each local delivery relay:false itself; passing relay:false here would
	// keep the event on this replica.
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
	ctx.publish(TOPICS.demoFromSeqFastEvents, 'created', fastEntry, { seq: fastSeq })
})

/**
 * Loaders return the recent window (last RECENT_WINDOW entries) tagged
 * `rehydrate`. The fromSeq bridge returns `{ event, data, seq }` envelopes,
 * not bare rows: a `replay: true` array response is fed straight into the
 * client's `_applyMerge`, which dispatches on `envelope.event`. Bare rows
 * carry no `event`, so they silently fail to merge.
 *
 * Live publishes from `tickEvents` arrive as 'created' events tagged `live`;
 * they merge into the existing list by id.
 */
async function loadRecentEvents() {
	const nextSeq = await getNextSeq()
	const startSeq = Math.max(1, nextSeq - RECENT_WINDOW + 1)
	const entries = await readRange(startSeq, nextSeq)
	return entries.map((e) => ({ ...e, tier: 'rehydrate' }))
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
		// roughly 3 minutes); an older gap reloads through the loader.
		// The flag also routes cron publishes through `replay.publish`
		// so they pick up the wire-level seq numbers the resume cursor
		// is expressed in.
		replay: true
	}
)

/**
 * The delta.fromSeq ladder: no replay buffer, so a resume goes straight to
 * the durable store. A gap of up to STORE_RETAIN events fills tagged
 * `fromSeq`; anything older reloads through the loader.
 */
export const eventStreamFast = live.stream(
	TOPICS.demoFromSeqFastEvents,
	async () => loadRecentFastEvents(),
	{
		merge: 'crud',
		key: 'id',
		max: STORE_RETAIN,
		delta: {
			fromSeq: loadFastEventsFromSeq
		}
	}
)
