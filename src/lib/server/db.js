/**
 * Database abstraction layer.
 *
 * Two implementations live in this file:
 * 1. PostgreSQL (production) - used when DATABASE_URL is set
 * 2. In-memory Map (development) - used when DATABASE_URL is not set
 *
 * Both expose the same function signatures. At the bottom of the file,
 * we export the right implementation based on the environment.
 *
 * Why two implementations? So you can run `npm run dev` without
 * installing Postgres. The in-memory store is ephemeral (data is lost
 * on restart) and doesn't enforce constraints like unique slugs or
 * foreign keys, so don't use it for anything serious.
 */

import pg from 'pg'
import { env } from '$env/dynamic/private'
import { runWithAdvisoryLock } from '$lib/server/advisory-lock'
import { boundedIntEnv } from '$lib/server/env-int'

const DEFAULT_POOL_MAX = 10
const DEFAULT_CONNECT_TIMEOUT_MS = 2000

/**
 * The process-wide PostgreSQL pool. Every database-backed subsystem wraps
 * this same pool so one worker has one explicit connection budget.
 */
export const databasePool = env.DATABASE_URL
	? new pg.Pool({
			connectionString: env.DATABASE_URL,
			max: boundedIntEnv(env.DATABASE_POOL_MAX, { min: 1, fallback: DEFAULT_POOL_MAX }),
			// A readiness probe must not sit forever in Pool.connect() while the
			// database host is unreachable. Individual query budgets are supplied
			// by the callers that need a tighter bound.
			connectionTimeoutMillis: boundedIntEnv(env.DATABASE_CONNECT_TIMEOUT_MS, { min: 100, max: 30_000, fallback: DEFAULT_CONNECT_TIMEOUT_MS })
		})
	: null

if (databasePool) {
	// pg emits idle-client failures on the Pool itself. Without a listener,
	// an ordinary database restart becomes an uncaught EventEmitter error and
	// terminates the Node process. Active queries still reject their callers;
	// this listener only makes idle failures observable and recoverable.
	databasePool.on('error', (err) => {
		console.error('[postgres] idle client error', {
			name: err?.name,
			code: err?.code,
			severity: err?.severity,
			routine: err?.routine
		})
	})
}

let closePromise = null

/** Close the shared pool exactly once during graceful worker shutdown. */
export function closeDatabase() {
	if (!databasePool) return Promise.resolve()
	closePromise ??= databasePool.end()
	return closePromise
}

// The adapter emits this only after HTTP/WebSocket drain. Closing from the
// earlier hooks.ws shutdown hook would reject requests still finishing during
// a graceful deploy.
if (databasePool) {
	process.once('sveltekit:shutdown', () => {
		closeDatabase().catch((error) => {
			console.error('[postgres] pool shutdown failed', {
				name: error?.name,
				code: error?.code
			})
		})
	})
}

const pool = databasePool

// ============================================================
// PostgreSQL implementation
// ============================================================

/** Run a parameterized query and return the rows. */
async function sql(query, params = [], queryable = pool) {
	const { rows } = await queryable.query(query, params)
	return rows
}

function pgGetBoard(boardId) {
	return sql(`
		SELECT board_id, title, slug, background, last_activity
		  FROM board
		 WHERE board_id = $1
	`, [boardId]).then(rows => rows[0])
}

function pgGetBoardBySlug(slug) {
	return sql(`
		SELECT board_id, title, slug, background, last_activity
		  FROM board
		 WHERE slug = $1
	`, [slug]).then(rows => rows[0])
}

/** Returns the 100 most recent boards. Capped to prevent unbounded queries. */
function pgListBoards() {
	return sql(`
		SELECT board_id, title, slug, last_activity
		  FROM board
	  ORDER BY created_at DESC
	  LIMIT 100
	`)
}

/**
 * Bump a board's last_activity timestamp to now.
 * Called on every meaningful user action (note CRUD, settings, arrangements).
 * Returns the updated board so callers can broadcast the new timestamp.
 */
function pgTouchBoard(boardId) {
	return sql(`
		UPDATE board SET last_activity = now()
		 WHERE board_id = $1
	 RETURNING board_id, title, slug, background, last_activity
	`, [boardId]).then(rows => rows[0])
}

/**
 * Delete a board and all its notes (notes cascade via FK).
 * Used by the cleanup job to remove stale boards.
 */
function pgDeleteBoard(boardId, queryable = pool) {
	return sql(`DELETE FROM board WHERE board_id = $1`, [boardId], queryable)
}

/**
 * Atomically delete boards that are still stale at statement execution time.
 * Returning the deleted rows lets the caller publish exactly what committed,
 * without a SELECT/DELETE race against a concurrent touchBoard().
 */
function pgDeleteStaleBoards(maxAgeMs, protectedSlugs = [], queryable = pool) {
	const cutoff = new Date(Date.now() - maxAgeMs)
	return sql(`
		DELETE FROM board
		 WHERE last_activity < $1
		   AND slug != ALL($2::text[])
		 RETURNING board_id, title, slug
	`, [cutoff, protectedSlugs], queryable)
}

/**
 * Ensure a board with the given slug exists. Creates it if missing.
 * Used at startup to guarantee well-known boards (like the stress test board).
 */
async function pgEnsureBoard({ title, slug }) {
	return sql(`
		INSERT INTO board (title, slug)
		     VALUES ($1, $2)
		ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
		  RETURNING board_id, title, slug, background, last_activity
	`, [title, slug]).then(rows => rows[0])
}

function pgCreateBoard({ title, slug }) {
	return sql(`
		INSERT INTO board (title, slug)
		     VALUES ($1, $2)
		  RETURNING board_id, title, slug, background, last_activity
	`, [title, slug]).then(rows => rows[0])
}

/**
 * Update specific fields on a board. Uses an allowlist pattern:
 * only 'title' and 'background' can be updated, everything else
 * is silently ignored. This prevents clients from modifying fields
 * like board_id or created_at.
 */
async function pgUpdateBoard(boardId, fields) {
	const allowed = ['title', 'background']
	const sets = []
	const params = []
	let i = 1

	for (const key of allowed) {
		if (fields[key] !== undefined) {
			sets.push(`${key} = $${i++}`)
			params.push(fields[key])
		}
	}

	if (sets.length === 0) return pgGetBoard(boardId)

	params.push(boardId)
	const [board] = await sql(`
		UPDATE board
		   SET ${sets.join(', ')}, last_activity = now()
		 WHERE board_id = $${i}
	 RETURNING board_id, title, slug, background, last_activity
	`, params)
	return board
}

/** Minimal query - only fetches the IDs for ownership verification. */
function pgGetNote(noteId) {
	return sql(`
		SELECT note_id, board_id, content, x, y, color, creator_name,
		       COALESCE(z_index, 0) AS z_index
		  FROM note
		 WHERE note_id = $1
	`, [noteId]).then(rows => rows[0])
}

/** Returns all non-archived notes for a board, ordered by creation time. */
function pgListNotes(boardId) {
	return sql(`
		  SELECT note_id, board_id, content, x, y, color, creator_name,
		         COALESCE(z_index, 0) AS z_index
		    FROM note
		   WHERE board_id = $1
		     AND NOT is_archived
		ORDER BY created_at
	`, [boardId])
}

function pgCreateNote({ boardId, content, x, y, color, creatorName }) {
	return sql(`
		INSERT INTO note (board_id, content, x, y, color, creator_name, z_index)
		     VALUES ($1, $2, $3, $4, $5, $6, 0)
		  RETURNING note_id, board_id, content, x, y, color, creator_name, z_index
	`, [boardId, content, x, y, color, creatorName]).then(rows => rows[0])
}

/** Update specific fields on a note. Same allowlist pattern as pgUpdateBoard. */
async function pgUpdateNote(noteId, fields) {
	const allowed = ['content', 'x', 'y', 'color', 'z_index']
	const sets = []
	const params = []
	let i = 1

	for (const key of allowed) {
		if (fields[key] !== undefined) {
			sets.push(`${key} = $${i++}`)
			params.push(fields[key])
		}
	}

	if (sets.length === 0) return null

	params.push(noteId)
	const [note] = await sql(`
		UPDATE note
		   SET ${sets.join(', ')}
		 WHERE note_id = $${i}
	 RETURNING note_id, board_id, content, x, y, color, creator_name, z_index
	`, params)
	return note
}

/**
 * Batch update positions and z-index for multiple notes in a single query.
 *
 * Used by the FAB arrangement actions (tidy, rearrange, shuffle, group).
 * Instead of updating notes one-by-one (N queries for N notes), this uses
 * PostgreSQL's unnest() to update all notes in one round trip.
 *
 * Each entry in `updates` must have: { note_id, x, y, z_index }
 */
async function pgBatchUpdateNotes(updates) {
	if (updates.length === 0) return []
	const ids = updates.map(u => u.note_id)
	const xs = updates.map(u => u.x)
	const ys = updates.map(u => u.y)
	const zs = updates.map(u => u.z_index)
	return sql(`
		UPDATE note AS n
		   SET x = v.x, y = v.y, z_index = v.z
		  FROM unnest($1::uuid[], $2::int[], $3::int[], $4::int[])
		    AS v(id, x, y, z)
		 WHERE n.note_id = v.id
	 RETURNING n.note_id, n.board_id, n.content, n.x, n.y, n.color, n.creator_name, n.z_index
	`, [ids, xs, ys, zs])
}

function pgDeleteNote(noteId) {
	return sql(`DELETE FROM note WHERE note_id = $1`, [noteId])
}

// ============================================================
// In-memory dev store
// ============================================================

const boardsMap = new Map()
const notesMap = new Map()

function memGetBoard(boardId) {
	const b = boardsMap.get(boardId)
	return b ? { board_id: b.board_id, title: b.title, slug: b.slug, background: b.background, last_activity: new Date(b.last_activity).toISOString() } : undefined
}

function memGetBoardBySlug(slug) {
	for (const b of boardsMap.values()) {
		if (b.slug === slug) return { board_id: b.board_id, title: b.title, slug: b.slug, background: b.background, last_activity: new Date(b.last_activity).toISOString() }
	}
	return undefined
}

function memListBoards() {
	return [...boardsMap.values()]
		.sort((a, b) => b.created_at - a.created_at)
		.slice(0, 100)
		.map(({ board_id, title, slug, last_activity }) => ({ board_id, title, slug, last_activity: new Date(last_activity).toISOString() }))
}

async function memTouchBoard(boardId) {
	const b = boardsMap.get(boardId)
	if (!b) return undefined
	b.last_activity = Date.now()
	return { board_id: b.board_id, title: b.title, slug: b.slug, background: b.background, last_activity: new Date(b.last_activity).toISOString() }
}

function memDeleteBoard(boardId) {
	boardsMap.delete(boardId)
	for (const [id, note] of notesMap) {
		if (note.board_id === boardId) notesMap.delete(id)
	}
}

function memDeleteStaleBoards(maxAgeMs, protectedSlugs = []) {
	const cutoff = Date.now() - maxAgeMs
	const deleted = []
	for (const board of boardsMap.values()) {
		if (board.last_activity >= cutoff || protectedSlugs.includes(board.slug)) continue
		deleted.push({ board_id: board.board_id, title: board.title, slug: board.slug })
		memDeleteBoard(board.board_id)
	}
	return deleted
}

async function memEnsureBoard({ title, slug }) {
	const existing = memGetBoardBySlug(slug)
	if (existing) return existing
	return memCreateBoard({ title, slug })
}

function memCreateBoard({ title, slug }) {
	const board = {
		board_id: crypto.randomUUID(),
		title,
		slug,
		background: '#f5f5f4',
		last_activity: Date.now(),
		created_at: Date.now()
	}
	boardsMap.set(board.board_id, board)
	return { board_id: board.board_id, title: board.title, slug: board.slug, background: board.background, last_activity: new Date(board.last_activity).toISOString() }
}

function memUpdateBoard(boardId, fields) {
	const board = boardsMap.get(boardId)
	if (!board) return undefined
	for (const key of ['title', 'background']) {
		if (fields[key] !== undefined) board[key] = fields[key]
	}
	board.last_activity = Date.now()
	return { board_id: board.board_id, title: board.title, slug: board.slug, background: board.background, last_activity: new Date(board.last_activity).toISOString() }
}

function memGetNote(noteId) {
	const n = notesMap.get(noteId)
	if (!n) return undefined
	return {
		note_id: n.note_id, board_id: n.board_id, content: n.content,
		x: n.x, y: n.y, color: n.color, creator_name: n.creator_name,
		z_index: n.z_index ?? 0
	}
}

function memListNotes(boardId) {
	return [...notesMap.values()]
		.filter(n => n.board_id === boardId && !n.is_archived)
		.sort((a, b) => a.created_at - b.created_at)
		.map(({ note_id, board_id, content, x, y, color, creator_name, z_index }) => ({
			note_id, board_id, content, x, y, color, creator_name, z_index: z_index ?? 0
		}))
}

function memCreateNote({ boardId, content, x, y, color, creatorName }) {
	const note = {
		note_id: crypto.randomUUID(),
		board_id: boardId,
		content: content ?? '',
		x: x ?? 200,
		y: y ?? 200,
		color: color ?? '#fef08a',
		creator_name: creatorName,
		z_index: 0,
		is_archived: false,
		created_at: Date.now()
	}
	notesMap.set(note.note_id, note)
	return { note_id: note.note_id, board_id: note.board_id, content: note.content, x: note.x, y: note.y, color: note.color, creator_name: note.creator_name, z_index: note.z_index }
}

function memUpdateNote(noteId, fields) {
	const note = notesMap.get(noteId)
	if (!note) return null
	for (const key of ['content', 'x', 'y', 'color', 'z_index']) {
		if (fields[key] !== undefined) note[key] = fields[key]
	}
	return { note_id: note.note_id, board_id: note.board_id, content: note.content, x: note.x, y: note.y, color: note.color, creator_name: note.creator_name, z_index: note.z_index }
}

function memBatchUpdateNotes(updates) {
	const results = []
	for (const u of updates) {
		const note = notesMap.get(u.note_id)
		if (!note) continue
		note.x = u.x
		note.y = u.y
		note.z_index = u.z_index
		results.push({ note_id: note.note_id, board_id: note.board_id, content: note.content, x: note.x, y: note.y, color: note.color, creator_name: note.creator_name, z_index: note.z_index })
	}
	return results
}

function memDeleteNote(noteId) {
	notesMap.delete(noteId)
}

// ============================================================
// Export the right implementation based on environment
// ============================================================

export const getNote = pool ? pgGetNote : memGetNote
export const getBoard = pool ? pgGetBoard : memGetBoard
export const getBoardBySlug = pool ? pgGetBoardBySlug : memGetBoardBySlug
export const listBoards = pool ? pgListBoards : memListBoards
export const createBoard = pool ? pgCreateBoard : memCreateBoard
export const updateBoard = pool ? pgUpdateBoard : memUpdateBoard
export const touchBoard = pool ? pgTouchBoard : memTouchBoard
export const deleteBoard = pool ? pgDeleteBoard : memDeleteBoard
export const deleteStaleBoards = pool ? pgDeleteStaleBoards : memDeleteStaleBoards
export const listNotes = pool ? pgListNotes : memListNotes
export const createNote = pool ? pgCreateNote : memCreateNote
export const updateNote = pool ? pgUpdateNote : memUpdateNote
export const batchUpdateNotes = pool ? pgBatchUpdateNotes : memBatchUpdateNotes
export const ensureBoard = pool ? pgEnsureBoard : memEnsureBoard
export const deleteNote = pool ? pgDeleteNote : memDeleteNote

/**
 * Run a critical section while holding a session-scoped advisory lock.
 *
 * The acquire and release queries deliberately use the same checked-out
 * client. Calling pool.query() for each statement can select two different
 * backend sessions, leaving the original session lock stranded in the pool.
 * Returns undefined when another replica already holds the lock.
 */
export async function withAdvisoryLock(lockId, criticalSection) {
	return runWithAdvisoryLock(pool, lockId, criticalSection)
}
