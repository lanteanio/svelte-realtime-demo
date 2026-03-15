/**
 * Board page server load -- resolves a URL slug to a board UUID.
 *
 * The slug is the human-readable part of the URL (e.g. "plucky-taco-576").
 * The board_id (UUID) is what all the RPCs use internally. This load
 * function bridges the two: look up the slug in the database and pass
 * the UUID to the client as `data.boardId`.
 *
 * If the slug doesn't match any board, we return a 404.
 */

import { getBoardBySlug } from '$lib/server/db'
import { error } from '@sveltejs/kit'

export async function load({ params }) {
	const board = await getBoardBySlug(params.slug)
	if (!board) error(404, 'Board not found')
	return { boardId: board.board_id, slug: params.slug }
}
