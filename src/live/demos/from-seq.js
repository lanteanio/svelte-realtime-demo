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
 * `_lastSeq` on the wire, the server's replay buffer doesn't cover
 * this topic (not in the REPLAY_TOPIC_RE whitelist), so the
 * framework falls through to `delta.fromSeq` which reads from the
 * durable hash and returns the missed entries tagged `fromSeq`.
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

async function getNextSeq() {
	const v = await redis.redis.get(NEXT_SEQ_KEY)
	if (v === null) return 0
	const n = Number(v)
	return Number.isFinite(n) ? n : 0
}

async function pruneStore(currentSeq) {
	if (currentSeq <= STORE_RETAIN) return
	const cutoff = currentSeq - STORE_RETAIN
	const fields = await redis.redis.hkeys(DURABLE_KEY)
	const toDelete = []
	for (const f of fields) {
		const s = Number(f)
		if (Number.isFinite(s) && s <= cutoff) toDelete.push(f)
	}
	if (toDelete.length > 0) await redis.redis.hdel(DURABLE_KEY, ...toDelete)
}

async function readRange(startSeq, endSeq) {
	if (endSeq < startSeq) return []
	const fields = []
	for (let s = startSeq; s <= endSeq; s++) fields.push(String(s))
	if (fields.length === 0) return []
	const values = await redis.redis.hmget(DURABLE_KEY, ...fields)
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
})

/**
 * Stream with `delta.fromSeq`. The loader returns the recent window
 * (last RECENT_WINDOW entries) tagged `rehydrate`. On reconnect
 * with a stale `lastSeq`, the framework checks the replay buffer
 * (this topic isn't in `REPLAY_TOPIC_RE` so it's skipped) and
 * falls through to `delta.fromSeq`, which reads the durable hash
 * and returns the missed entries tagged `fromSeq`.
 *
 * Live publishes from `tickEvents` arrive as 'created' events
 * tagged `live`; they merge into the existing list by id.
 */
export const eventStream = live.stream(
	TOPICS.demoFromSeqEvents,
	async () => {
		const nextSeq = await getNextSeq()
		const startSeq = Math.max(1, nextSeq - RECENT_WINDOW + 1)
		const entries = await readRange(startSeq, nextSeq)
		return entries.map((e) => ({ ...e, tier: 'rehydrate' }))
	},
	{
		merge: 'crud',
		key: 'id',
		max: STORE_RETAIN,
		// `replay: true` opts this stream into the platform's bounded
		// replay buffer (configured in src/lib/server/redis.js). The
		// buffer covers gaps within its size (200 events at 1Hz =
		// roughly 3 minutes); for older gaps the framework falls
		// through to `delta.fromSeq` below. Topic is whitelisted in
		// `REPLAY_TOPIC_RE` (src/hooks.ws.js) so cron publishes go
		// through `replay.publish` and pick up wire-level seq numbers.
		replay: true,
		delta: {
			fromSeq: async (sinceSeq) => {
				if (typeof sinceSeq !== 'number' || sinceSeq < 0) return null
				const nextSeq = await getNextSeq()
				const entries = await readRange(sinceSeq + 1, nextSeq)
				return entries.map((e) => ({ ...e, tier: 'fromSeq' }))
			}
		}
	}
)
