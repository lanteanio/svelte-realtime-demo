// realtime-allow-public -- this anonymous collaborative demo is intentionally public.
/**
 * Cursor and presence RPCs for board-level tracking.
 *
 * These are thin wrappers around the Redis presence and cursor plugins.
 * They're called from the client via the PresenceBar and Canvas components.
 *
 * joinBoard/leaveBoard: manage per-board presence (who's on this board).
 * moveCursor: update this user's cursor position on the board.
 *
 * All three are in the THROTTLED_RPCS set in hooks.ws.js, meaning they
 * bypass rate limiting (they fire too frequently to be rate-limited).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { cursor, presence } from '$lib/server/redis'
import { TOPICS } from '$lib/server/topics'

/** Register this connection as present on the given board. */
export const joinBoard = live(async (ctx, boardId) => {
	if (ctx.shed('background')) throw new LiveError('OVERLOADED', 'Server under pressure, retry shortly')
	const topic = TOPICS.boardPresence(boardId)
	try {
		await presence.join(ctx.ws, topic, ctx.platform)
		// cursor.attach is required as of extensions next.14: the adapter no
		// longer wire-subscribes clients to `__cursor:` topics, so cross-tab
		// cursors land in an empty subscriber set without this call. attach
		// uses platform.subscribe (server-trust path) and folds the initial
		// snapshot send into the same call.
		await cursor.attach(ctx.ws, topic, ctx.platform)
	} catch (error) {
		if (error instanceof LiveError) throw error
		// cursor.attach authorizes before granting (extensions next.63) and
		// throws SUBSCRIBE_DENIED on refusal - a denial, not an outage.
		if (error?.code === 'SUBSCRIBE_DENIED') throw new LiveError('FORBIDDEN', 'Not allowed on this board')
		throw new LiveError('REALTIME_UNAVAILABLE', 'Realtime presence is temporarily unavailable')
	}
})

/** Remove this connection from the board's presence list and cursor overlay. */
export const leaveBoard = live(async (ctx, boardId) => {
	// leave is not shed - letting users free resources is always allowed
	const topic = TOPICS.boardPresence(boardId)
	await presence.leave(ctx.ws, ctx.platform, topic)
	cursor.detach(ctx.ws, topic, ctx.platform)
	await cursor.remove(ctx.ws, ctx.platform, topic)
})

/** Update this user's cursor position on the board canvas. */
export const moveCursor = live.volatile((ctx, boardId, position) => {
	if (ctx.shed('background')) return
	cursor.update(ctx.ws, TOPICS.boardPresence(boardId), position, ctx.platform)
})
