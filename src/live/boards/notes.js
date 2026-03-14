import { live, LiveError } from 'svelte-realtime/server'
import {
	listNotes,
	getNote as dbGetNote,
	createNote as dbCreateNote,
	updateNote as dbUpdateNote,
	deleteNote as dbDeleteNote
} from '$lib/server/db'
import { validateNoteContent, validateCoord, validateNoteColor, validateNoteFields, validateZIndex } from '$lib/server/validate'

async function verifyNoteOwnership(noteId, boardId) {
	if (!noteId || !boardId) throw new LiveError('VALIDATION', 'Note ID and Board ID required')
	const existing = await dbGetNote(noteId)
	if (!existing) throw new LiveError('NOT_FOUND', 'Note not found')
	if (existing.board_id !== boardId) throw new LiveError('FORBIDDEN', 'Note does not belong to this board')
}

export const createNote = live(async (ctx, boardId, { content, x, y, color }) => {
	if (!boardId) throw new LiveError('VALIDATION', 'Board ID required')
	const note = await dbCreateNote({
		boardId,
		content: validateNoteContent(content ?? ''),
		x: validateCoord(x ?? 200, 'x'),
		y: validateCoord(y ?? 200, 'y'),
		color: validateNoteColor(color ?? '#fef08a'),
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
	await verifyNoteOwnership(noteId, boardId)
	const note = await dbUpdateNote(noteId, { x: validateCoord(x, 'x'), y: validateCoord(y, 'y') })
	if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	return note
})

export const editNote = live(async (ctx, boardId, noteId, fields) => {
	await verifyNoteOwnership(noteId, boardId)
	const clean = validateNoteFields(fields)
	if (Object.keys(clean).length === 0) throw new LiveError('VALIDATION', 'No valid fields to update')
	const note = await dbUpdateNote(noteId, clean)
	if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	if (clean.content !== undefined) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'edited a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	if (clean.color) {
		ctx.publish(`board:${boardId}:activity`, 'created', {
			action: 'recolored a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
		})
	}
	return note
})

export const focusNote = live(async (ctx, boardId, noteId, zIndex) => {
	ctx.throttle(`focus:${noteId}`, 100)
	await verifyNoteOwnership(noteId, boardId)
	const note = await dbUpdateNote(noteId, { z_index: validateZIndex(zIndex) })
	if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	return note
})

export const deleteNote = live(async (ctx, boardId, noteId) => {
	await verifyNoteOwnership(noteId, boardId)
	await dbDeleteNote(noteId)
	ctx.publish(`board:${boardId}:notes`, 'deleted', { note_id: noteId })
	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'removed a note', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
})

export const notes = live.stream((ctx, boardId) => `board:${boardId}:notes`, async (ctx, boardId) => {
	return listNotes(boardId)
}, { merge: 'crud', key: 'note_id' })
