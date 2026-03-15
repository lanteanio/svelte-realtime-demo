import { live, LiveError } from 'svelte-realtime/server'
import { listBoards, createBoard as dbCreateBoard } from '$lib/server/db'
import { generateSlug } from '$lib/names'
import { validateBoardTitle } from '$lib/server/validate'

export const createBoard = live(async (ctx, title) => {
	const cleanTitle = validateBoardTitle(title)
	let board
	for (let attempt = 0; attempt < 5; attempt++) {
		const slug = generateSlug()
		try {
			board = await dbCreateBoard({ title: cleanTitle, slug })
			break
		} catch (err) {
			const isUniqueViolation = err?.code === '23505' || err?.message?.includes('UNIQUE')
			if (!isUniqueViolation || attempt === 4) throw err
		}
	}
	if (!board) throw new LiveError('SERVER_ERROR', 'Could not generate a unique board URL, please try again')
	ctx.publish('boards', 'created', board)
	return board
})

export const boards = live.stream('boards', async () => {
	return listBoards()
}, { merge: 'crud', key: 'board_id' })
