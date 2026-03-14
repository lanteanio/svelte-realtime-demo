import { live, LiveError } from 'svelte-realtime/server'
import { getBoard, updateBoard } from '$lib/server/db'

export const updateSettings = live(async (ctx, boardId, fields) => {
	if (!boardId) throw new LiveError('VALIDATION', 'Board ID required')
	const board = await updateBoard(boardId, fields)
	ctx.publish(`board:${boardId}:settings`, 'set', board)
	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'changed the background', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	return board
})

export const settings = live.stream('board-settings', async (ctx, boardId) => {
	return getBoard(boardId)
}, { merge: 'set' })
