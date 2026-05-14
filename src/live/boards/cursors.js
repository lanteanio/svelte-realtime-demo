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
	await presence.join(ctx.ws, TOPICS.boardPresence(boardId), ctx.platform)
})

/** Remove this connection from the board's presence list and cursor overlay. */
export const leaveBoard = live(async (ctx, boardId) => {
	// leave is not shed - letting users free resources is always allowed
	await presence.leave(ctx.ws, ctx.platform, TOPICS.boardPresence(boardId))
	cursor.remove(ctx.ws, ctx.platform, TOPICS.boardPresence(boardId))
})

/** Update this user's cursor position on the board canvas. */
export const moveCursor = live((ctx, boardId, position) => {
	if (ctx.shed('background')) return
	cursor.update(ctx.ws, TOPICS.boardPresence(boardId), position, ctx.platform)
})
