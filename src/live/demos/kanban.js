// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/kanban - one shared CRDT board via live.doc with map/array facets.
 *
 * The pitch: a three-column kanban everyone edits at once, with NO RPC
 * handlers at all. Every client holds a local replica of the document;
 * a write applies locally in the same tick and merges everywhere. Two
 * tabs moving the same card concurrently both survive, because every
 * array element carries its own CRDT identity - no index-shift races,
 * no server round trip deciding a winner.
 *
 * Data model (named containers on ONE document, one update stream):
 * - map 'cards'        : card id -> { title, color }
 * - array 'order-todo' : card ids in column order
 * - array 'order-doing'
 * - array 'order-done'
 *
 * Moving a card is delete-from-one-array + push-to-another inside
 * doc.transact(), so the move rides the wire as ONE atomic update: a
 * peer never observes the card in zero or two columns.
 *
 * The topic is a static string - one shared board for every visitor,
 * which is the point of a merge demo. The guard explicitly grants
 * everyone read + write (a boolean widens to the full access record);
 * being explicit also keeps the one-time no-guard production warning
 * out of the logs.
 *
 * `persist` hooks keep the board across reloads and restarts. The
 * framework releases a document's in-memory replica once its last
 * subscriber disconnects (an unsubscribed doc is not held for the
 * process lifetime), so a single visitor's reload - which briefly drops
 * the only subscriber - would otherwise reset the board. The compacted
 * CRDT snapshot lands in Redis behind a 24h TTL: long enough to survive
 * a reload or a deploy, short enough that a public board does not
 * accumulate forever (the TTL doubles as the board's moderation reset).
 * The framework owns the debounce/compaction schedule; the app owns the
 * two I/O calls.
 *
 * Cluster convergence needs no wiring here: src/hooks.ws.js attaches
 * `platform.crdt` (the Redis CRDT coordinator) app-wide, so edits
 * landing on different replicas relay and converge automatically.
 */

import { live } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const SNAPSHOT_KEY = 'demos:kanban:doc:snapshot'
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60

export const kanban = live.doc({
	topic: TOPICS.demoKanbanBoard,
	guard: () => true,
	persist: {
		// getBuffer returns raw bytes (a Buffer is a Uint8Array) or null for
		// a brand-new board - exactly the load contract.
		load: () => redis.redis.getBuffer(SNAPSHOT_KEY),
		store: async (topic, bytes) => {
			await redis.redis.set(SNAPSHOT_KEY, Buffer.from(bytes), 'EX', SNAPSHOT_TTL_SECONDS)
		}
	}
})
