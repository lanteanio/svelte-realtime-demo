// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/offline - durable offline queue + idempotent replay guestbook.
 *
 * The pitch: entries posted while the tab has no network queue on the
 * client, survive a full page reload (IndexedDB), and replay exactly
 * once on reconnect. The server's half of that contract is this file:
 *
 * - `addEntry` wraps in live.idempotent. Every persisted offline
 *   mutation carries an idempotency key (the queue synthesizes one
 *   when the call supplied none), so a replay after a crash - or a
 *   replay of a mutation whose ack got lost - answers with the
 *   original result instead of posting twice. Pairing the queue with
 *   live.idempotent server-side is the documented recipe.
 * - The idempotency cache is the cluster-shared Redis store, so a
 *   replay that reconnects to a DIFFERENT replica still dedups.
 *
 * Storage is a cluster-shared Redis LIST capped at MAX_ENTRIES via
 * LTRIM (newest first: LPUSH + LRANGE 0 N-1). An entry posted on one
 * replica reaches subscribers everywhere via the cluster pub/sub
 * fan-out of the 'created' event.
 *
 * The purge cron (src/lib/server/demo-purge.js) registers demo purges
 * centrally; this module just exports its purge(ctx).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'
import { TOPICS } from '$lib/server/topics'

const MAX_ENTRIES = 50
const ENTRIES_KEY = 'demos:offline:list'

/**
 * Cluster-shared idempotency store. The TTL is sized for the offline
 * story, not for double-taps: a queued mutation can replay minutes or
 * hours after it first (maybe) reached the server, so the dedup window
 * must comfortably outlive a realistic offline stretch.
 */
const idempotencyStore = createIdempotencyStore(redis, {
	keyPrefix: 'demos:offline:idemp:',
	ttl: 3600,
	acquireTtl: 30,
	breaker,
	metrics
})

async function listEntries() {
	const raws = await redis.redis.lrange(ENTRIES_KEY, 0, MAX_ENTRIES - 1)
	const out = []
	for (const raw of raws) {
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

// Newest-first list; live 'created' publishes prepend to match the
// loader's LPUSH ordering.
export const entriesStream = live.stream(TOPICS.demoOfflineEntries, async () => listEntries(), {
	merge: 'crud',
	key: 'id',
	prepend: true
})

export const addEntry = live.idempotent(
	{ ttl: 3600, store: idempotencyStore },
	async (ctx, text) => {
		const trimmed = String(text ?? '').trim().slice(0, 200)
		if (!trimmed) throw new LiveError('VALIDATION', 'Entry text required')
		const entry = {
			id: crypto.randomUUID(),
			text: trimmed,
			by: ctx.user.name,
			at: Date.now()
		}
		// LPUSH newest-first, LTRIM caps the list. Entries falling off the
		// tail vanish from the loader on the next rehydrate; publishing
		// per-eviction 'deleted' events is overkill for a 50-entry
		// guestbook whose page always shows the head of the list.
		const pipeline = redis.redis.multi()
		pipeline.lpush(ENTRIES_KEY, JSON.stringify(entry))
		pipeline.ltrim(ENTRIES_KEY, 0, MAX_ENTRIES - 1)
		await pipeline.exec()
		ctx.publish(TOPICS.demoOfflineEntries, 'created', entry)
		return entry
	}
)

/**
 * Wipe the guestbook. 'set' [] replaces the whole list on every
 * subscriber in one event; per-entry 'deleted' fan-out buys nothing
 * for a full wipe. Idempotency cache keys are NOT touched; their TTL
 * handles itself.
 */
export async function purge(ctx) {
	const removed = await redis.redis.llen(ENTRIES_KEY)
	await redis.redis.del(ENTRIES_KEY)
	ctx.publish(TOPICS.demoOfflineEntries, 'set', [])
	return { entries: removed }
}
