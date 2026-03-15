/**
 * Board CRUD -- live RPCs and streams.
 *
 * live() creates an RPC function that clients can call over WebSocket.
 * live.stream() creates a reactive data stream that clients subscribe to.
 *
 * When a board is created, we publish a 'created' event on the 'boards'
 * topic. Every client subscribed to the boards stream sees the new board
 * appear instantly (no polling, no refetch).
 */

import { live, LiveError } from 'svelte-realtime/server'
import { listBoards, createBoard as dbCreateBoard } from '$lib/server/db'
import { generateSlug } from '$lib/names'
import { validateBoardTitle } from '$lib/server/validate'

/**
 * Create a new board.
 *
 * Slugs are random (e.g. "plucky-taco-576") and must be unique in the
 * database. Since they're generated randomly, collisions can happen.
 * We retry up to 5 times with different slugs before giving up.
 */
export const createBoard = live(async (ctx, title) => {
	const cleanTitle = validateBoardTitle(title)
	let board
	for (let attempt = 0; attempt < 5; attempt++) {
		const slug = generateSlug()
		try {
			board = await dbCreateBoard({ title: cleanTitle, slug })
			break
		} catch (err) {
			// Postgres unique violation = code 23505. In-memory store throws with 'UNIQUE' in message.
			const isUniqueViolation = err?.code === '23505' || err?.message?.includes('UNIQUE')
			if (!isUniqueViolation || attempt === 4) throw err
		}
	}
	if (!board) throw new LiveError('SERVER_ERROR', 'Could not generate a unique board URL, please try again')
	ctx.publish('boards', 'created', board)
	return board
})

/**
 * Live stream of all boards.
 *
 * merge: 'crud' means the client automatically applies created/updated/deleted
 * events to its local array, keyed by board_id. So when any user creates a
 * board, every other user's board list updates in real time.
 */
export const boards = live.stream('boards', async () => {
	return listBoards()
}, { merge: 'crud', key: 'board_id' })
