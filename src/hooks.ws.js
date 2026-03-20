/**
 * WebSocket lifecycle hooks.
 *
 * These functions run on the server whenever a WebSocket connection
 * is established, receives a message, subscribes to a topic, or closes.
 * Think of them as middleware for your WebSocket layer.
 *
 * The adapter calls them automatically -- you just export the right names.
 */

import { createMessage, LiveError } from 'svelte-realtime/server'
import { bus, limiter, presence, cursor } from '$lib/server/redis'
import { generateIdentity } from '$lib/names'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Validate an identity object from the cookie. Returns null if invalid.
 * We check every field strictly -- never trust client-provided data.
 */
function validateIdentity(obj) {
	if (!obj || typeof obj !== 'object') return null
	if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) return null
	if (typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 40) return null
	if (typeof obj.color !== 'string' || !HEX_COLOR_RE.test(obj.color)) return null
	return { id: obj.id, name: obj.name, color: obj.color }
}

/**
 * Called when a client wants to upgrade from HTTP to WebSocket.
 * Whatever this function returns becomes `ws.getUserData()` for the
 * lifetime of that connection. Here we use it to attach the user's identity.
 *
 * If the client has a valid identity cookie, we reuse it.
 * Otherwise, we generate a fresh random identity (no login required).
 */
export function upgrade({ cookies }) {
	const existing = cookies.identity
	if (existing) {
		try {
			const parsed = validateIdentity(JSON.parse(existing))
			if (parsed) return parsed
		} catch {}
	}

	const identity = {
		id: crypto.randomUUID(),
		...generateIdentity()
	}

	// Set the cookie so the identity persists across page refreshes
	cookies.identity = JSON.stringify(identity)
	return identity
}

/**
 * Called once when the WebSocket connection is fully open.
 * We activate the Redis pub/sub bus (so cross-instance messaging works)
 * and register this connection in the "global" presence channel.
 */
export function open(ws, { platform }) {
	bus.activate(platform)
	presence.join(ws, 'global', platform)
}

/**
 * Called when a client subscribes to a live stream topic.
 * We delegate to the presence and cursor plugins so they can track
 * who's watching what and send cursor snapshots to new joiners.
 */
export function subscribe(ws, topic, ctx) {
	presence.hooks.subscribe(ws, topic, ctx)
	cursor.hooks.subscribe(ws, topic, ctx)
}

/**
 * Called when a client's topic reference count reaches zero.
 * This fires in real time (the moment the client drops a topic),
 * not only at socket close. We clean up presence and cursor state
 * for just that topic so departed users disappear immediately.
 */
export function unsubscribe(ws, topic, ctx) {
	presence.hooks.unsubscribe(ws, topic, ctx)
}

/**
 * Called when the WebSocket closes (tab closed, network drop, etc).
 * Clean up: remove from all remaining presence channels and delete
 * cursor state. The unsubscribe hook already handled any topics the
 * client explicitly dropped before disconnect, so close only handles
 * whatever is still active.
 */
export function close(ws, ctx) {
	presence.hooks.close(ws, ctx)
	cursor.hooks.close(ws, ctx)
}

/**
 * RPCs that should bypass rate limiting. These fire very frequently
 * during normal use (every mouse move, every drag frame) and would
 * instantly exhaust the rate limit budget if counted.
 */
const THROTTLED_RPCS = new Set(['boards/notes/moveNote', 'boards/cursors/moveCursor', 'boards/cursors/joinBoard'])

/**
 * The message handler processes all incoming RPC calls from clients.
 * Before each RPC executes, we check the rate limit (unless it's a
 * throttled RPC like cursor movement).
 *
 * Rate limit: 100 requests per 10 seconds per user. If exceeded, the
 * client gets a RATE_LIMITED error with a countdown.
 */
export const message = createMessage({
	platform: (p) => bus.wrap(p),
	async beforeExecute(ws, rpcPath) {
		if (THROTTLED_RPCS.has(rpcPath)) return
		const { allowed, resetMs } = await limiter.consume(ws)
		if (!allowed) throw new LiveError('RATE_LIMITED', `Retry in ${Math.ceil(resetMs / 1000)}s`)
	}
})
