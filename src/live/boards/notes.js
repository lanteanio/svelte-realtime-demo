import { live, LiveError } from 'svelte-realtime/server'
import {
	listNotes,
	createNote as dbCreateNote,
	updateNote as dbUpdateNote,
	deleteNote as dbDeleteNote
} from '$lib/server/db'

export const createNote = live(async (ctx, boardId, { content, x, y, color }) => {
	if (!boardId) throw new LiveError('VALIDATION', 'Board ID required')
	const note = await dbCreateNote({
		boardId, content, x, y, color,
		creatorName: ctx.user.name
	})
	ctx.publish(`board:${boardId}:notes`, 'created', note)
	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'added a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	return note
})

export const moveNote = live(async (ctx, boardId, noteId, x, y) => {
	ctx.throttle(`move:${noteId}`, 50)
	const note = await dbUpdateNote(noteId, { x, y })
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	return note
})

export const editNote = live(async (ctx, boardId, noteId, fields) => {
	const note = await dbUpdateNote(noteId, fields)
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	if (fields.content !== undefined) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'edited a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	if (fields.color) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'recolored a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	return note
})

export const deleteNote = live(async (ctx, boardId, noteId) => {
	await dbDeleteNote(noteId)
	ctx.publish(`board:${boardId}:notes`, 'deleted', { note_id: noteId })
	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'removed a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
})

export const notes = live.stream('board-notes', async (ctx, boardId) => {
	return listNotes(boardId)
}, { merge: 'crud', key: 'note_id' })
