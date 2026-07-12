// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/multiplayer - the full-surface live.multiplayer() room.
 *
 * One export, every collaborative surface the primitive offers, on a
 * single fixed lounge topic:
 *
 * - presence: the visitor roster (name + color), which also carries
 *   the typing flags, the advisory lock, and nothing else - typing,
 *   locks, and selections are presence FIELDS stamped on the caller's
 *   roster entry, so they cost no extra subscription.
 * - cursors: live pointer positions, published volatile (lossy under
 *   disconnect is the contract) and keyed by identity.
 * - typing: an ephemeral per-user flag; never persisted on the roster.
 * - locks: ['headline'] - an advisory awareness lock on the headline
 *   input. It tells collaborators who is editing, it does NOT block a
 *   second writer; the setHeadline action below stays the authority.
 * - reactions: a dedicated ephemeral stream of emote taps, never
 *   coalesced, GC'd off a bounded ring client-side.
 *
 * The headline itself is the room's data stream: init loads the
 * current record from Redis (cluster-shared, so every replica serves
 * the same value), and the setHeadline action validates, stores, and
 * publishes 'updated' so the crud merge replaces the record on every
 * subscriber. Selections are intentionally omitted here;
 * /demos/collab-editor is the showcase for those.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { redis } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

const HEADLINE_KEY = 'demos:multiplayer:headline'
const HEADLINE_MAX = 80
const DEFAULT_HEADLINE = 'Grab the lock and rewrite this headline.'

async function loadHeadline() {
	const raw = await redis.redis.get(HEADLINE_KEY)
	if (raw) {
		try { return JSON.parse(raw) } catch { /* corrupt record, fall through */ }
	}
	return { id: 'headline', text: DEFAULT_HEADLINE, by: null, ts: 0 }
}

export const lounge = live.multiplayer({
	topic: (ctx) => TOPICS.demoMultiplayerLounge,
	topicArgs: 0,
	// init seeds the data stream with the single headline record; the
	// 'updated' publish in setHeadline merges by id onto this entry.
	init: async () => [await loadHeadline()],
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color }),
	cursors: true,
	typing: true,
	locks: ['headline'],
	reactions: true,
	actions: {
		setHeadline: async (ctx, text) => {
			if (typeof text !== 'string') throw new LiveError('VALIDATION', 'Headline must be a string')
			const trimmed = text.trim()
			if (!trimmed) throw new LiveError('VALIDATION', 'Headline required')
			if (trimmed.length > HEADLINE_MAX) {
				throw new LiveError('VALIDATION', `Headline must be ${HEADLINE_MAX} characters or less`)
			}
			const record = { id: 'headline', text: trimmed, by: ctx.user.name, ts: Date.now() }
			await redis.redis.set(HEADLINE_KEY, JSON.stringify(record))
			ctx.publish('updated', record)
			return record
		}
	}
})
