import { getBoardBySlug } from '$lib/server/db'
import { error } from '@sveltejs/kit'

export async function load({ params }) {
	const board = await getBoardBySlug(params.slug)
	if (!board) error(404, 'Board not found')
	return { boardId: board.board_id, slug: params.slug }
}
