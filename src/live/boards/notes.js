// realtime-allow-public -- this anonymous collaborative demo is intentionally public.
/**
 * Note CRUD and arrangement actions - live RPCs and streams.
 *
 * Notes are the sticky notes on a board. Each note has:
 * - Position (x, y) for where it sits on the canvas
 * - Content (text the user types)
 * - Color (one of 6 preset colors)
 * - z_index (stacking order - higher = on top)
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
import { TOPICS } from '$lib/server/topics'
import { acknowledgeNoteFlush, mergeNoteMutation, reconcileBatchPosition } from '$lib/server/note-buffer'
import { activityEvent } from './activity'

/**
 * Touch the board's last_activity and broadcast the update to the
 * boards list so home page timers refresh. Fire-and-forget - we don't
 * await this because it's not critical to the note operation.
 */
function touch(ctx, boardId) {
	touchBoard(boardId).then(board => {
		if (!board) return
		// Update the home page board list timer
		ctx.publish(TOPICS.boards, 'updated', board)
		// Update the board page header timer. The settings stream uses 'set'
		// merge (replaces the whole object), so we send all fields.
		ctx.publish(TOPICS.settings(boardId), 'set', board)
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

/**
 * Create a note on the canvas.
 *
 * Wrapped in live.idempotent: a client that double-clicks the canvas in
 * quick succession or retries through a flaky reconnect with the same
 * idempotencyKey gets one note, not two. Short TTL because two notes a
 * minute apart in the same spot are almost always intentional.
 */
export const createNote = live.idempotent({ ttl: 60 }, async (ctx, boardId, { content, x, y, color }) => {
	validateBoardId(boardId)
	const note = await dbCreateNote({
		boardId,
		content: validateNoteContent(content ?? ''),
		x: validateCoord(x ?? 200, 'x'),
		y: validateCoord(y ?? 200, 'y'),
		color: validateNoteColor(color ?? '#fef08a'),
		creatorName: ctx.user.name
	})
	ctx.publish(TOPICS.notes(boardId), 'created', note)
	ctx.publish(TOPICS.activity(boardId), 'created', activityEvent(ctx, 'added a note'))
	touch(ctx, boardId)
	return note
})

/**
 * In-flight drag buffer + DB-write batcher.
 *
 * moveNote can fire at the client's display-refresh rate (60-120Hz) per
 * active drag. Running verifyNoteOwnership + UPDATE on every call would
 * issue ~240 postgres queries/sec per drag, saturating the pool and
 * stalling observers behind the queue.
 *
 * Same pattern the extensions cursor plugin uses (snapshotIntervalMs):
 * keep the latest position in memory, broadcast every move at full rate
 * (so observers see smooth motion), and flush the latest x/y to postgres
 * on a 100ms timer regardless of inbound rate. 120Hz client drag
 * collapses to ~10 UPDATEs/sec per active note.
 *
 * Entries are LOCAL to this replica. Cross-replica edits (editNote /
 * recolor / etc) invalidate locally via _invalidateNoteCache(noteId);
 * the next moveNote on this replica re-fetches the fresh row. Inflight
 * drags briefly publish stale non-position fields when a foreign edit
 * lands, but the window is bounded by the time-to-next-moveNote on the
 * dragging replica (<16ms at 120Hz drag).
 */
const _noteCache = new Map() // noteId -> { boardId, note, dirty, version, flushPromise, lastTouch }
const _FLUSH_INTERVAL_MS = 100
const _CACHE_TTL_MS = 10_000
let _flushTimer = null
let _lastFlushWarningAt = 0

function _ensureFlushTimer() {
	if (_flushTimer) return
	_flushTimer = setInterval(_flushNoteCache, _FLUSH_INTERVAL_MS)
	if (_flushTimer.unref) _flushTimer.unref()
}

async function _flushNoteCache() {
	const now = Date.now()
	const dirtyEntries = []
	for (const [id, entry] of _noteCache) {
		if (entry.dirty && !entry.flushPromise) dirtyEntries.push([id, entry])
		else if (!entry.dirty && !entry.flushPromise && now - entry.lastTouch > _CACHE_TTL_MS) _noteCache.delete(id)
	}
	if (_noteCache.size === 0 && _flushTimer) {
		clearInterval(_flushTimer)
		_flushTimer = null
	}
	if (dirtyEntries.length === 0) return

	await Promise.all(dirtyEntries.map(async ([id, entry]) => {
		const version = entry.version
		const { x, y } = entry.note
		const flushPromise = dbUpdateNote(id, { x, y })
		entry.flushPromise = flushPromise
		try {
			const fresh = await flushPromise
			// An invalidating mutation may have removed/replaced this entry while
			// the write was in flight. Never mutate a replacement cache entry.
			if (_noteCache.get(id) !== entry) return
			if (!fresh) {
				_noteCache.delete(id)
				return
			}
			// Merge DB-side fields back so any concurrent foreign edit lands
			// on our cached shape before the next broadcast. Preserve the latest
			// in-memory position if more move frames arrived during this write.
			acknowledgeNoteFlush(entry, version, fresh)
		} catch (err) {
			// Keep dirty=true so the latest position is durable once PostgreSQL
			// recovers. Throttle the warning because a drag buffer ticks at 10Hz.
			if (Date.now() - _lastFlushWarningAt >= 5000) {
				_lastFlushWarningAt = Date.now()
				console.warn('[notes] buffered position flush failed; retrying', {
					code: err?.code,
					name: err?.name
				})
			}
		} finally {
			// A delete can temporarily detach and then restore this entry when
			// its DELETE fails. Clear this exact settled generation even while
			// detached so a restored dirty entry remains eligible for retry.
			if (entry.flushPromise === flushPromise) entry.flushPromise = null
		}
	}))
}

/**
 * Invalidate the in-flight drag cache for a note. Called from every
 * non-moveNote mutation so the next moveNote on this replica refetches
 * the fresh row. For batch arrangements that touch many notes at once,
 * use _invalidateAllNotesCache().
 */
function _mergeNoteCache(note) {
	const entry = _noteCache.get(note.note_id)
	if (!entry) return note
	mergeNoteMutation(entry, note)
	return entry.note
}

function _cacheVersions() {
	return new Map([..._noteCache].map(([id, entry]) => [id, entry.version]))
}

function _reconcileBatchCache(updated, versions) {
	const effective = []
	for (const note of updated) {
		const entry = _noteCache.get(note.note_id)
		effective.push(entry
			? reconcileBatchPosition(entry, versions.get(note.note_id), note)
			: note)
	}
	if (_noteCache.size > 0) _ensureFlushTimer()
	return effective
}

/**
 * Move a note to a new position. Hot path during drag.
 *
 * - Cold (first call per noteId on this replica): SELECT + cache.
 * - Hot: cache lookup + in-memory position update + immediate broadcast.
 * - DB UPDATE happens on the periodic flusher, not per call.
 *
 * Background-class: silently dropped under pressure. The client is
 * doing optimistic display via store.mutate so a few dropped intermediate
 * frames are invisible; the next non-shed move catches up.
 */
export const moveNote = live(async (ctx, boardId, noteId, x, y) => {
	if (ctx.shed('background')) return
	const cx = validateCoord(x, 'x')
	const cy = validateCoord(y, 'y')
	const now = Date.now()

	let entry = _noteCache.get(noteId)
	// Treat cross-board cache hit as a miss. Forces verifyNoteOwnership
	// to re-run on the cold path so a poisoned cache entry can't be used
	// to publish on a board the caller shouldn't have access to.
	if (entry && entry.boardId !== boardId) entry = undefined
	if (!entry) {
		await verifyNoteOwnership(noteId, boardId)
		const fresh = await dbGetNote(noteId)
		if (!fresh) throw new LiveError('NOT_FOUND', 'Note not found')
		entry = { boardId, note: fresh, dirty: false, version: 0, flushPromise: null, lastTouch: now }
		_noteCache.set(noteId, entry)
		_ensureFlushTimer()
	}

	entry.note = { ...entry.note, x: cx, y: cy }
	entry.dirty = true
	entry.version++
	entry.lastTouch = now
	ctx.publish(TOPICS.notes(boardId), 'updated', entry.note)
})

/**
 * Edit note content, color, or other fields.
 *
 * Wrapped in live.lock per noteId: two users editing the same note
 * serialize FIFO instead of racing. maxWaitMs bounds the queue depth so
 * a stuck handler does not block other waiters indefinitely; queued
 * callers reject with LiveError('LOCK_TIMEOUT', ...) after 5s.
 */
export const editNote = live.lock(
	{ key: (ctx, _boardId, noteId) => `note:${noteId}`, maxWaitMs: 5000 },
	async (ctx, boardId, noteId, fields) => {
		await verifyNoteOwnership(noteId, boardId)
		const clean = validateNoteFields(fields)
		if (Object.keys(clean).length === 0) throw new LiveError('VALIDATION', 'No valid fields to update')
		const note = await dbUpdateNote(noteId, clean)
		if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
		const merged = _mergeNoteCache(note)
		ctx.publish(TOPICS.notes(boardId), 'updated', merged)
		if (clean.content !== undefined) {
			ctx.publish(TOPICS.activity(boardId), 'created', activityEvent(ctx, 'edited a note'))
		}
		if (clean.color) {
			ctx.publish(TOPICS.activity(boardId), 'created', activityEvent(ctx, 'recolored a note'))
		}
		touch(ctx, boardId)
		return merged
	}
)

/**
 * Bring a note to the front (increase its z-index). Click-frequency
 * operation; no need for an in-handler rate gate (rate-limiter on the
 * RPC layer handles abuse; human click cadence is fine on raw DB).
 *
 * Background-class: z-order tweaks are nice-to-have. Silently dropped
 * under pressure; the user can click again when the system recovers.
 */
export const focusNote = live(async (ctx, boardId, noteId, zIndex) => {
	if (ctx.shed('background')) return
	await verifyNoteOwnership(noteId, boardId)
	const note = await dbUpdateNote(noteId, { z_index: validateZIndex(zIndex) })
	if (!note) throw new LiveError('NOT_FOUND', 'Note not found')
	const merged = _mergeNoteCache(note)
	ctx.publish(TOPICS.notes(boardId), 'updated', merged)
	return merged
})

export const deleteNote = live(async (ctx, boardId, noteId) => {
	await verifyNoteOwnership(noteId, boardId)
	const detached = _noteCache.get(noteId)
	_noteCache.delete(noteId)
	try {
		await dbDeleteNote(noteId)
	} catch (error) {
		// Preserve a buffered position if the delete itself did not commit.
		if (detached && !_noteCache.has(noteId)) {
			_noteCache.set(noteId, detached)
			_ensureFlushTimer()
		}
		throw error
	}
	ctx.publish(TOPICS.notes(boardId), 'deleted', { note_id: noteId })
	ctx.publish(TOPICS.activity(boardId), 'created', activityEvent(ctx, 'removed a note'))
	touch(ctx, boardId)
})

// --- Batch arrangement actions ---
// All of these read all notes, compute new positions, then write
// everything back in a single SQL query using batchUpdateNotes().

/** Sort notes by position (top-left to bottom-right) and reset z-order. */
export const tidyNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	await _flushNoteCache()
	const versions = _cacheVersions()
	const allNotes = await listNotes(boardId)
	if (allNotes.length === 0) return []

	const sorted = [...allNotes].sort((a, b) => (a.x + a.y) - (b.x + b.y))
	const updates = sorted.map((note, i) => ({
		note_id: note.note_id, x: note.x, y: note.y, z_index: i
	}))

	const persisted = await dbBatchUpdateNotes(updates)
	const updated = _reconcileBatchCache(persisted, versions)
	ctx.platform.publishBatched([
		...updated.map(note => ({ topic: TOPICS.notes(boardId), event: 'updated', data: note })),
		{ topic: TOPICS.activity(boardId), event: 'created', data: activityEvent(ctx, 'tidied the board') }
	])
	touch(ctx, boardId)
	return updated
})

/** Group notes by color into cascading columns. */
export const rearrangeNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	await _flushNoteCache()
	const versions = _cacheVersions()
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

	const persisted = await dbBatchUpdateNotes(updates)
	const updated = _reconcileBatchCache(persisted, versions)
	ctx.platform.publishBatched([
		...updated.map(note => ({ topic: TOPICS.notes(boardId), event: 'updated', data: note })),
		{ topic: TOPICS.activity(boardId), event: 'created', data: activityEvent(ctx, 'rearranged the board') }
	])
	touch(ctx, boardId)
	return updated
})

/** Scatter notes randomly across the canvas. */
export const shuffleNotes = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	await _flushNoteCache()
	const versions = _cacheVersions()
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

	const persisted = await dbBatchUpdateNotes(updates)
	const updated = _reconcileBatchCache(persisted, versions)
	ctx.platform.publishBatched([
		...updated.map(note => ({ topic: TOPICS.notes(boardId), event: 'updated', data: note })),
		{ topic: TOPICS.activity(boardId), event: 'created', data: activityEvent(ctx, 'shuffled the board') }
	])
	touch(ctx, boardId)
	return updated
})

/** Group notes by their creator into cascading columns. */
export const groupByAuthor = live(async (ctx, boardId) => {
	validateBoardId(boardId)
	await _flushNoteCache()
	const versions = _cacheVersions()
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

	const persisted = await dbBatchUpdateNotes(updates)
	const updated = _reconcileBatchCache(persisted, versions)
	ctx.platform.publishBatched([
		...updated.map(note => ({ topic: TOPICS.notes(boardId), event: 'updated', data: note })),
		{ topic: TOPICS.activity(boardId), event: 'created', data: activityEvent(ctx, 'grouped notes by author') }
	])
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
export const notes = live.stream((ctx, boardId) => TOPICS.notes(boardId), async (ctx, boardId) => {
	return listNotes(boardId)
}, { merge: 'crud', key: 'note_id', replay: true })
