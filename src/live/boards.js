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
import { listBoards, createBoard as dbCreateBoard, listStaleBoards, deleteBoard as dbDeleteBoard, tryAdvisoryLock, advisoryUnlock } from '$lib/server/db'
import { generateSlug } from '$lib/names'
import { validateBoardTitle } from '$lib/server/validate'

/** How long a board lives without activity (1 hour). */
const BOARD_TTL_MS = 60 * 60 * 1000

/** Slugs that never expire. */
const PROTECTED_SLUGS = ['stress-me-out']

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

/**
 * Cleanup cron -- runs every minute.
 *
 * Finds boards that haven't had activity in BOARD_TTL_MS (1 hour)
 * and deletes them. Protected boards (stress-me-out) are exempt.
 *
 * Uses a Postgres advisory lock so only one replica runs the cleanup
 * when multiple instances are deployed. The others skip the tick.
 *
 * Publishes batched 'deleted' events so the crud merge on the client
 * removes each board from the list.
 */
const CLEANUP_LOCK_ID = 900001

export const cleanupStaleBoards = live.cron('* * * * *', 'boards', async (ctx) => {
	const acquired = await tryAdvisoryLock(CLEANUP_LOCK_ID)
	if (!acquired) return
	try {
		const stale = await listStaleBoards(BOARD_TTL_MS, PROTECTED_SLUGS)
		for (const board of stale) {
			await dbDeleteBoard(board.board_id)
		}
		if (stale.length > 0) {
			ctx.batch(stale.map(board => ({ topic: 'boards', event: 'deleted', data: { board_id: board.board_id } })))
			console.log(`[cleanup] Deleted ${stale.length} stale board(s): ${stale.map(b => b.slug).join(', ')}`)
		}
	} finally {
		await advisoryUnlock(CLEANUP_LOCK_ID)
	}
})
