// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/phases - the attach/detach lifecycle + the atomic publish batch.
 *
 * Two client-visible primitives on one small feed:
 *
 * 1. `store.attach()` / `store.detach()` / the `phase` store. Every
 *    stream store exposes its per-subscription attach machine as a
 *    read-only `phase` store (`initialized -> attaching -> attached ->
 *    detached | failed`). `attach()` holds an internal retain, so the
 *    stream stays subscribed with no UI subscriber and auto-reattaches
 *    across outages; `detach()` means "done" - it releases the retain
 *    and tears the subscription down immediately, with no resume-grace
 *    retention. The page drives both buttons against the feed below and
 *    renders the phase badge live.
 *
 * 2. `ctx.batch(fn)` - the all-or-nothing publish collector. Every
 *    `ctx.publish` inside the function - INCLUDING after awaits - is
 *    buffered and flushed together when the function resolves; a throw
 *    (or rejection) drops every buffered publish. Contrast with bare
 *    `ctx.publish`, which flushes at each microtask boundary, so a
 *    pre-await publish is already on the wire when a later throw
 *    happens.
 *
 * What ctx.batch does NOT roll back: storage. The collector retracts
 * PUBLISHES only - a Redis write made before the throw stays written,
 * because your datastore's transaction semantics are your own problem.
 * `postTwo` is therefore structured so the claim "a throw drops every
 * buffered publish" is exactly true end to end: all validation (the
 * deliberate midway failure) runs first, across a real await boundary,
 * and the Redis writes happen only after the last possible throw - so
 * a failed call leaves neither a partial publish trail NOR a partial
 * list.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const FEED_KEY = 'demos:phases:feed'
const FEED_MAX = 10

function makeEntry(label, half) {
	return { id: crypto.randomUUID(), label, half, at: Date.now() }
}

/**
 * The feed stream. Loader returns the last FEED_MAX entries, oldest
 * first, so `merge: 'crud'` appends fresh 'created' events at the end.
 */
export const feed = live.stream(
	TOPICS.demoPhasesFeed,
	async () => {
		const raws = await redis.redis.lrange(FEED_KEY, 0, FEED_MAX - 1)
		const out = []
		for (const raw of raws) {
			try { out.push(JSON.parse(raw)) } catch { /* skip corrupt entry */ }
		}
		return out.reverse()
	},
	{ merge: 'crud', key: 'id' }
)

/**
 * Publish two entries atomically. With `failMidway`, the handler throws
 * BETWEEN the two buffered publishes and after a real await boundary -
 * proving that the first publish, although already issued inside the
 * collector, never reaches any subscriber.
 *
 * Ordering inside the collector, and why:
 * 1. buffer publish A
 * 2. await (a genuine microtask+timer boundary - outside a collector,
 *    publish A would be on the wire by now)
 * 3. the deliberate midway throw (drops publish A from the buffer;
 *    nothing was written anywhere)
 * 4. buffer publish B
 * 5. Redis writes + bounded-list eviction (with 'deleted' publishes
 *    buffered into the same batch)
 * 6. collector flushes everything at once
 * The storage writes sit after every throw site because ctx.batch
 * retracts publishes, never storage - see the module JSDoc.
 */
export const postTwo = live(async (ctx, failMidway) => {
	const first = makeEntry('first half', 1)
	const second = makeEntry('second half', 2)
	return ctx.batch(async () => {
		ctx.publish(TOPICS.demoPhasesFeed, 'created', first)
		// A real await boundary between the two publishes. Bare
		// ctx.publish would have flushed `first` to the wire here.
		await new Promise((resolve) => setTimeout(resolve, 25))
		if (failMidway) {
			throw new LiveError('VALIDATION', 'midway failure - nothing above was published')
		}
		ctx.publish(TOPICS.demoPhasesFeed, 'created', second)
		// Storage last, after the final throw site. LPUSH newest-first
		// (multi-value LPUSH leaves the LAST argument at the head, so
		// passing first-then-second puts `second` on top); LRANGE
		// captures what LTRIM is about to evict so subscribers get a
		// 'deleted' for each (buffered into this same batch).
		const pipeline = redis.redis.multi()
		pipeline.lpush(FEED_KEY, JSON.stringify(first), JSON.stringify(second))
		pipeline.lrange(FEED_KEY, FEED_MAX, -1)
		pipeline.ltrim(FEED_KEY, 0, FEED_MAX - 1)
		const results = await pipeline.exec()
		const evicted = /** @type {string[]} */ (results?.[1]?.[1] ?? [])
		for (const raw of evicted) {
			try {
				const dropped = JSON.parse(raw)
				ctx.publish(TOPICS.demoPhasesFeed, 'deleted', { id: dropped.id })
			} catch { /* corrupt entry already evicted */ }
		}
		return { first, second }
	})
})

/**
 * Drop every feed entry. Callable from the shared demo-purge
 * orchestrator shape.
 */
export async function purge(ctx) {
	const raws = await redis.redis.lrange(FEED_KEY, 0, -1)
	await redis.redis.del(FEED_KEY)
	let dropped = 0
	for (const raw of raws) {
		try {
			const entry = JSON.parse(raw)
			ctx.publish(TOPICS.demoPhasesFeed, 'deleted', { id: entry.id })
			dropped++
		} catch { /* corrupt entry already gone */ }
	}
	return { dropped }
}
