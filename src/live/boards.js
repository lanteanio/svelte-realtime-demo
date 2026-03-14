import { live, LiveError } from 'svelte-realtime/server'
import { listBoards, createBoard as dbCreateBoard } from '$lib/server/db'
import { generateSlug } from '$lib/names'

export const createBoard = live(async (ctx, title) => {
	if (!title?.trim()) throw new LiveError('VALIDATION', 'Title required')
	const slug = generateSlug()
	const board = await dbCreateBoard({ title: title.trim(), slug })
	ctx.publish('boards', 'created', board)
	return board
})

export const boards = live.stream('boards', async () => {
	return listBoards()
}, { merge: 'crud', key: 'board_id' })
