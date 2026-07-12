// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/collab-editor - CRDT-anchored selections vs raw offsets.
 *
 * The pitch: two multiplayer rooms share ONE collaborative document,
 * and the only thing that differs between them is the selection layer.
 *
 * - live.doc() declares the shared document. Both panels bind their
 *   textarea to the same doc.text('body') facet, so every keystroke in
 *   either panel is the same CRDT edit stream - the comparison between
 *   the two selection modes is honest because the text underneath the
 *   selections is identical.
 * - offsetRoom declares selections: 'offset'. A selection is published
 *   as raw { start, end } offsets stamped on the caller's presence
 *   entry. Offsets are only correct while the document does not change
 *   underneath them: an insert BEFORE a remote selection shifts the
 *   text but not the stored offsets, so the highlight drifts onto the
 *   wrong characters.
 * - crdtRoom declares selections: 'crdt' and the client binds it to
 *   the document with room.bindDoc(doc). setSelection encodes the
 *   range as a position anchor inside the CRDT; room.selections
 *   resolves every peer's anchor back to CURRENT offsets reactively,
 *   so the highlight stays glued to the selected characters no matter
 *   who edits where.
 *
 * The selection modes are per-export config, not a topic arg, so the
 * comparison needs two exports on two fixed topics. Presence is
 * required by both: a selection is stamped on the caller's roster
 * entry, and a roster entry only exists once presence is set.
 *
 * The document persists as a compacted CRDT snapshot in Redis with a
 * 24h TTL - long enough to survive restarts and deploys, short enough
 * that a public scratchpad does not accumulate graffiti forever. The
 * framework owns the persist schedule (debounced after edits, flushed
 * when the last subscriber leaves); these hooks only do the I/O.
 * platform.crdt is wired in hooks.ws.js, so replicas converge across
 * the cluster and the snapshot stays single-writer.
 */

import { live } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const SNAPSHOT_KEY = 'demos:collab-editor:doc:snapshot'
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60

export const editorDoc = live.doc({
	topic: TOPICS.demoCollabDoc,
	// Explicitly public: everyone connected may read and write. Same
	// effect as omitting the guard, minus the production warning.
	guard: () => ({ read: true, write: true }),
	persist: {
		// getBuffer returns raw bytes (a Buffer is a Uint8Array) or null
		// for a brand-new document - exactly the load contract.
		load: () => redis.redis.getBuffer(SNAPSHOT_KEY),
		store: async (topic, bytes) => {
			await redis.redis.set(SNAPSHOT_KEY, Buffer.from(bytes), 'EX', SNAPSHOT_TTL_SECONDS)
		}
	}
})

export const offsetRoom = live.multiplayer({
	topic: (ctx) => TOPICS.demoCollabOffset,
	topicArgs: 0,
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color }),
	selections: 'offset'
})

export const crdtRoom = live.multiplayer({
	topic: (ctx) => TOPICS.demoCollabCrdt,
	topicArgs: 0,
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color }),
	selections: 'crdt'
})
