/**
 * Note CRUD and arrangement actions -- live RPCs and streams.
 *
 * Notes are the sticky notes on a board. Each note has:
 * - Position (x, y) for where it sits on the canvas
 * - Content (text the user types)
 * - Color (one of 6 preset colors)
 * - z_index (stacking order -- higher = on top)
 * - creator_name (captured at creation time, not linked to a user account)
 *
 * All mutations publish events to the board's notes topic. Connected
 * clients see changes in real time via the notes stream.
 *
 * The arrangement actions (tidy, rearrange, shuffle, groupByAuthor)
 * update all notes in a single batch SQL query instead of one-by-one,
 * turning N+1 queries into 2 queries (1 read + 1 batch write).
 */

import { live, LiveError } from 'svelte-realtime/server'
import {
	listNotes,
	getNote as dbGetNote,
	createNote as dbCreateNote,
	updateNote as dbUpdateNote,
	deleteNote as dbDeleteNote,
	batchUpdateNotes as dbBatchUpdateNotes,
	touchBoard
} from '$lib/server/db'
import { validateBoardId, validateNoteId, validateNoteContent, validateCoord, validateNoteColor, validateNoteFields, validateZIndex } from '$lib/server/validate'

/**
 * Touch the board's last_activity and broadcast the update to the
 * boards list so home page timers refresh. Fire-and-forget -- we don't
 * await this because it's not critical to the note operation.
 */
function touch(ctx, boardId) {
	touchBoard(boardId).then(board => {
		if (board) ctx.publish('boards', 'updated', board)
	}).catch(() => {})
}

/**
 * Verify that a note exists and belongs to the specified board.
 * Prevents cross-board note manipulation.
 */
async function verifyNoteOwnership(noteId, boardId) {
	validateNoteId(noteId)
	validateBoardId(boardId)
	const existing = await dbGetNote(noteId)
	if (!existing) throw new LiveError('NOT_FOUND', 'Note not found')
	if (existing.board_id !== boardId) throw new LiveError('FORBIDDEN', 'Note does not belong to this board')
}

// --- Single-note operations ---

export const createNote = live(async (ctx, boardId, { content, x, y, color }) => {
	validateBoardId(boardId)
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
	touch(ctx, boardId)
	return note
})

/**
 * Move a note to a new position.
 * Throttled to 50ms -- during a drag, the client fires this on every
 * mouse move, but the server only processes it every 50ms at most.
 */
export const moveNote = live(async (ctx, boardId, noteId, x, y) => {
	ctx.throttle(`move:${noteId}`, 50)
	await verifyNoteOwnership(noteId, boardId)
	const note = await dbUpdateNote(noteId, { x: validateCoord(x, 'x'), y: validateCoord(y, 'y') })
	if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
	ctx.publish(`board:${boardId}:notes`, 'updated', note)
	return note
})

/** Edit note content, color, or other fields. */
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
	touch(ctx, boardId)
	return note
})

/**
 * Bring a note to the front (increase its z-index).
 * Throttled to 100ms to avoid spamming the DB on rapid clicks.
 */
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
	touch(ctx, boardId)
})

// --- Batch arrangement actions ---
// All of these read all notes, compute new positions, then write
// everything back in a single SQL query using batchUpdateNotes().

/** Sort notes by position (top-left to bottom-right) and reset z-order. */
export const tidyNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	const allNotes = await listNotes(boardId)
	if (allNotes.length === 0) return []

	const sorted = [...allNotes].sort((a, b) => (a.x + a.y) - (b.x + b.y))
	const updates = sorted.map((note, i) => ({
		note_id: note.note_id, x: note.x, y: note.y, z_index: i
	}))

	const updated = await dbBatchUpdateNotes(updates)
	for (const note of updated) {
		ctx.publish(`board:${boardId}:notes`, 'updated', note)
	}

	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'tidied the board', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	touch(ctx, boardId)
	return updated
})

/** Group notes by color into cascading columns. */
export const rearrangeNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	const allNotes = await listNotes(boardId)
	if (allNotes.length === 0) return []

	// Group by color
	const groups = new Map()
	for (const note of allNotes) {
		if (!groups.has(note.color)) groups.set(note.color, [])
		groups.get(note.color).push(note)
	}

	// Layout constants (px)
	const NOTE_WIDTH = 230  // w-52 = 208px + gap
	const CASCADE_X = 4     // slight offset per card in a stack
	const CASCADE_Y = 35    // vertical gap between stacked cards
	const START_X = 40
	const START_Y = 40
	const COLUMN_GAP = 30

	let zCounter = 0
	const updates = []
	let colIndex = 0

	for (const [, colorNotes] of groups) {
		const colX = START_X + colIndex * (NOTE_WIDTH + COLUMN_GAP)
		for (let i = 0; i < colorNotes.length; i++) {
			updates.push({
				note_id: colorNotes[i].note_id,
				x: colX + i * CASCADE_X,
				y: START_Y + i * CASCADE_Y,
				z_index: zCounter++
			})
		}
		colIndex++
	}

	const updated = await dbBatchUpdateNotes(updates)
	for (const note of updated) {
		ctx.publish(`board:${boardId}:notes`, 'updated', note)
	}

	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'rearranged the board', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	touch(ctx, boardId)
	return updated
})

/** Scatter notes randomly across the canvas. */
export const shuffleNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	const allNotes = await listNotes(boardId)
	if (allNotes.length === 0) return []

	// Scale area with note count, but cap at 9000 to stay within coordinate bounds
	const AREA_W = Math.min(Math.max(800, allNotes.length * 120), 9000)
	const AREA_H = Math.min(Math.max(600, allNotes.length * 90), 9000)
	const MARGIN = 40

	const updates = allNotes.map((note, i) => ({
		note_id: note.note_id,
		x: MARGIN + Math.floor(Math.random() * (AREA_W - MARGIN * 2)),
		y: MARGIN + Math.floor(Math.random() * (AREA_H - MARGIN * 2)),
		z_index: i
	}))

	const updated = await dbBatchUpdateNotes(updates)
	for (const note of updated) {
		ctx.publish(`board:${boardId}:notes`, 'updated', note)
	}

	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'shuffled the board', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	touch(ctx, boardId)
	return updated
})

/** Group notes by their creator into cascading columns. */
export const groupByAuthor = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	const allNotes = await listNotes(boardId)
	if (allNotes.length === 0) return []

	const groups = new Map()
	for (const note of allNotes) {
		const author = note.creator_name || 'Unknown'
		if (!groups.has(author)) groups.set(author, [])
		groups.get(author).push(note)
	}

	const NOTE_WIDTH = 230
	const CASCADE_X = 4
	const CASCADE_Y = 35
	const START_X = 40
	const START_Y = 40
	const COLUMN_GAP = 30

	let zCounter = 0
	const updates = []
	let colIndex = 0

	for (const [, authorNotes] of groups) {
		const colX = START_X + colIndex * (NOTE_WIDTH + COLUMN_GAP)
		for (let i = 0; i < authorNotes.length; i++) {
			updates.push({
				note_id: authorNotes[i].note_id,
				x: colX + i * CASCADE_X,
				y: START_Y + i * CASCADE_Y,
				z_index: zCounter++
			})
		}
		colIndex++
	}

	const updated = await dbBatchUpdateNotes(updates)
	for (const note of updated) {
		ctx.publish(`board:${boardId}:notes`, 'updated', note)
	}

	ctx.publish(`board:${boardId}:activity`, 'created', {
		action: 'grouped notes by author', user: ctx.user.name, color: ctx.user.color, ts: Date.now()
	})
	touch(ctx, boardId)
	return updated
})

// --- Live stream ---

/**
 * Reactive stream of notes for a given board.
 *
 * The topic is dynamic: each board has its own topic (board:{id}:notes).
 * merge: 'crud' means created/updated/deleted events are automatically
 * applied to the client's local array, keyed by note_id.
 *
 * When any user on the same board creates, edits, moves, or deletes
 * a note, every other user's notes array updates instantly.
 */
export const notes = live.stream((ctx, boardId) => `board:${boardId}:notes`, async (ctx, boardId) => {
	return listNotes(boardId)
}, { merge: 'crud', key: 'note_id' })
