/**
 * /demos/from-seq: three-tier reconnect via delta.fromSeq.
 *
 * The pitch. A 1Hz cron publishes events on a topic, each with an
 * incrementing `seq`. The stream's loader returns the recent
 * window from a durable store and tags every entry `tier:
 * 'rehydrate'`. Live publishes (the cron) tag `tier: 'live'`.
 * `delta.fromSeq(sinceSeq)` is wired to the same durable store and
 * tags `tier: 'fromSeq'` on every event it returns. The page
 * renders all events with their tier as a badge, so you can see
 * which path delivered each one.
 *
 * Demo flow: the page subscribes; live events arrive tagged
 * `live`. Click Pause; the page unsubscribes from this stream
 * (subCount hits 0, SDK drops the subscription). The server's cron
 * keeps publishing; events are stored in the durable Map. Click
 * Resume; the page re-subscribes, the SDK sends its cached
 * `_lastSeq` on the wire, the server's replay buffer doesn't cover
 * this topic (not in the REPLAY_TOPIC_RE whitelist), so the
 * framework falls through to `delta.fromSeq` which reads from the
 * durable Map and returns the missed entries tagged `fromSeq`.
 *
 * The headline primitive: `delta.fromSeq(sinceSeq)` - the
 * user-provided bridge for older-than-buffer reconnects, the third
 * tier of the reconnect resolution chain (replay buffer ->
 * fromSeq -> rehydrate via loader).
 *
 * Storage is in-memory. The durable Map keeps the last
 * STORE_RETAIN entries; the live ticker advances `seq` on every
 * tick. Cron is gated on the cluster leader-election primitive in
 * hooks.ws.js so multi-instance deployments fire the tick exactly
 * once.
 */

import { live } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'

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

let nextSeq = 0
/** @type {Map<number, { id: string, seq: number, ts: number, message: string, tier: string }>} */
const durable = new Map()

function pruneStore() {
	if (durable.size <= STORE_RETAIN) return
	const cutoff = nextSeq - STORE_RETAIN
	for (const seq of durable.keys()) {
		if (seq <= cutoff) durable.delete(seq)
	}
}

export const myFromSeqState = live(async () => ({
	storeRetain: STORE_RETAIN,
	recentWindow: RECENT_WINDOW
}))

/**
 * The headline. Cron tick at 1Hz publishes one event per tick. The
 * event is stored in the durable Map AND broadcast as a live
 * publish. Stored events feed both the loader's recent-window
 * rehydrate and `delta.fromSeq`'s gap-fill on reconnect.
 */
export const tickEvents = live.cron('* * * * * *', TOPICS.demoFromSeqEvents, async (ctx) => {
	nextSeq += 1
	const seq = nextSeq
	const entry = {
		id: 'evt-' + seq,
		seq,
		ts: Date.now(),
		message: PHRASES[seq % PHRASES.length] + ' #' + seq,
		tier: 'live'
	}
	durable.set(seq, entry)
	pruneStore()
	ctx.publish(TOPICS.demoFromSeqEvents, 'created', entry)
})

/**
 * Stream with `delta.fromSeq`. The loader returns the recent window
 * (last RECENT_WINDOW entries) tagged `rehydrate`. On reconnect
 * with a stale `lastSeq`, the framework checks the replay buffer
 * (this topic isn't in `REPLAY_TOPIC_RE` so it's skipped) and
 * falls through to `delta.fromSeq`, which reads the durable Map
 * and returns the missed entries tagged `fromSeq`.
 *
 * Live publishes from `tickEvents` arrive as 'created' events
 * tagged `live`; they merge into the existing list by id.
 */
export const eventStream = live.stream(
	TOPICS.demoFromSeqEvents,
	async () => {
		const entries = []
		const startSeq = Math.max(1, nextSeq - RECENT_WINDOW + 1)
		for (let s = startSeq; s <= nextSeq; s++) {
			const e = durable.get(s)
			if (e) entries.push({ ...e, tier: 'rehydrate' })
		}
		return entries
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
				const out = []
				for (let s = sinceSeq + 1; s <= nextSeq; s++) {
					const e = durable.get(s)
					if (e) out.push({ ...e, tier: 'fromSeq' })
				}
				return out
			}
		}
	}
)
