import { live } from 'svelte-realtime/server'
import { cursor, presence } from '$lib/server/redis'

export const joinBoard = live(async (ctx, boardId) => {
	await presence.join(ctx.ws, `board:${boardId}`, ctx.platform)
})

export const leaveBoard = live(async (ctx, boardId) => {
	await presence.leave(ctx.ws, ctx.platform, `board:${boardId}`)
	cursor.remove(ctx.ws, ctx.platform, `board:${boardId}`)
})

export const moveCursor = live((ctx, boardId, position) => {
	cursor.update(ctx.ws, `board:${boardId}`, position, ctx.platform)
})
