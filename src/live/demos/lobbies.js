// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/lobbies - room enumeration + ownership + share codes.
 *
 * The pitch: a lobby browser with zero bookkeeping. A table becomes
 * visible the moment its first subscriber arrives (meta resolved once,
 * count live), the first joiner holds the owner role with deterministic
 * succession, and each table's share code comes from shortCodes() -
 * unguessable, reversible, no lookup table.
 *
 * The code secret has a checked-in fallback ON PURPOSE: codes are share
 * handles, not authorization (the framework README's own framing - "a
 * code is a hard-to-guess handle, not proof of authorization"). A room
 * that needs access control keeps a guard; this one is a public demo, so
 * it stays guard-free and the secret only pins code stability across
 * replicas and restarts. Set ROOMS_CODE_SECRET to rotate independently.
 *
 * Messages are intentionally ephemeral (init returns []): the table feed
 * demonstrates room fan-out + owner gating, not durable chat -
 * /demos/chat is the durable-feed showcase.
 */

import { live, shortCodes, LiveError } from 'svelte-realtime/server'
import { env } from '$env/dynamic/private'
import { TOPICS } from '$lib/server/topics'

const codes = shortCodes({
	secret: env.ROOMS_CODE_SECRET || 'demo-lobbies-code-secret',
	length: 6
})

const MESSAGE_MAX = 140

/**
 * Table ids are client-chosen numerics. encode() throws outside
 * [0, 62^6), so an out-of-range id degrades to a code-less card instead
 * of a throwing meta (which would strip the whole card).
 */
function codeFor(id) {
	const n = Number(id)
	return Number.isInteger(n) && n >= 0 && n < codes.space ? codes.encode(n) : null
}

export const lobby = live.room({
	topic: (ctx, id) => TOPICS.demoLobbiesRoom(id),
	topicArgs: 1,
	init: async () => [],
	// meta is resolved once when the table opens (first subscriber) and is
	// the room's display card in the rooms() lobby browser. Pure and
	// JSON-serializable, as the cluster roster requires.
	meta: (id) => ({ name: `Table ${id}`, code: codeFor(id), cap: 8 }),
	enumerable: true,
	owner: true,
	ownerOnly: ['closeTable'],
	presence: (ctx) => ({ name: ctx.user.name, color: ctx.user.color }),
	actions: {
		say: (ctx, id, text) => {
			const trimmed = String(text ?? '').trim().slice(0, MESSAGE_MAX)
			if (!trimmed) throw new LiveError('VALIDATION', 'Message required')
			ctx.publish('created', {
				id: crypto.randomUUID(),
				text: trimmed,
				by: ctx.user.name,
				color: ctx.user.color,
				at: Date.now()
			})
		},
		// Owner-gated via ownerOnly: any other caller is rejected with
		// FORBIDDEN before this runs (and an ownerless room rejects too -
		// fail closed). 'refreshed' replaces the crud list wholesale, so
		// every member's feed clears at once.
		closeTable: (ctx, id) => {
			ctx.publish('refreshed', [])
		}
	}
})

/**
 * Server-side code resolution: decode() needs the secret, so the client
 * cannot resolve codes locally. decode is total over well-formed codes -
 * a made-up code may still decode to SOME table id. That is fine here
 * because a code is a share handle, not authorization; an app with a
 * store would validate the decoded id against it.
 */
export const resolveCode = live(async (ctx, code) => {
	const id = codes.decode(String(code ?? '').trim())
	return id === null ? null : String(id)
})
