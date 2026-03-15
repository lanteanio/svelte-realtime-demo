/**
 * Board settings -- live RPC and stream.
 *
 * Settings are board-level properties like title and background color.
 * merge: 'set' means the entire settings object is replaced on each
 * update (not merged field-by-field like CRUD).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { getBoard, updateBoard } from '$lib/server/db'
import { validateBoardId, validateBoardFields } from '$lib/server/validate'

export const updateSettings = live(async (ctx, boardId, fields) => {
	validateBoardId(boardId)
	const clean = validateBoardFields(fields)
	if (Object.keys(clean).length === 0) throw new LiveError('VALIDATION', 'No valid fields to update')
	const board = await updateBoard(boardId, clean)
	if (!board) throw new LiveError('NOT_FOUND', 'Board not found')
	ctx.publish(`board:${boardId}:settings`, 'set', board)
	if (clean.title !== undefined) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'renamed the board', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	if (clean.background !== undefined) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'changed the background', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	return board
})

export const settings = live.stream((ctx, boardId) => `board:${boardId}:settings`, async (ctx, boardId) => {
	return getBoard(boardId)
}, { merge: 'set' })
