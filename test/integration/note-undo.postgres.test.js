import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { before, after, test } from 'node:test'
import pg from 'pg'
import { postgresNoteUndo } from '../../src/lib/server/note-undo.js'

const connectionString = process.env.NOTE_UNDO_TEST_DATABASE_URL
assert.ok(connectionString, 'NOTE_UNDO_TEST_DATABASE_URL must name a disposable PostgreSQL database')
const schema = `undo_${crypto.randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString })
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
const store = postgresNoteUndo(pool)

before(async () => {
	await admin.query(`CREATE SCHEMA ${schema}`)
	for (const file of ['001_application_schema.sql', '004_note_deletion_undo.sql']) {
		await pool.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
	}
})

after(async () => {
	await pool.end()
	await admin.query(`DROP SCHEMA ${schema} CASCADE`)
	await admin.end()
})

async function fixture() {
	const actorId = crypto.randomUUID()
	const { rows: [board] } = await pool.query('INSERT INTO board (title, slug) VALUES ($1, $2) RETURNING *', ['Test board', crypto.randomUUID()])
	const { rows: [note] } = await pool.query(`INSERT INTO note (board_id, content, x, y, color, creator_name, z_index)
		VALUES ($1, 'Retain this content', 310, 260, '#bfdbfe', 'Visitor', 9) RETURNING *`, [board.board_id])
	return { boardId: board.board_id, actorId, note }
}

test('PostgreSQL restores the full snapshot once and lists it only for its owner', async () => {
	const f = await fixture()
	const receipt = await store.remove(f.boardId, f.note.note_id, f.actorId)
	assert.equal((await pool.query('SELECT * FROM note WHERE note_id=$1', [f.note.note_id])).rowCount, 0)
	const [listed] = await store.list(f.boardId, f.actorId)
	assert.equal(listed.token, receipt.token)
	assert.equal(listed.expiresAt, receipt.expiresAt)
	assert.ok(listed.remainingMs > 0 && listed.remainingMs <= receipt.remainingMs)
	assert.ok(receipt.remainingMs > 29_000 && receipt.remainingMs <= 30_000)
	for (const [board, actor] of [[crypto.randomUUID(), f.actorId], [f.boardId, crypto.randomUUID()]]) {
		assert.deepEqual(await store.list(board, actor), [])
		assert.equal(await store.restore(board, receipt.token, actor), null)
	}
	const results = await Promise.all(Array.from({ length: 4 }, () => store.restore(f.boardId, receipt.token, f.actorId)))
	assert.equal(results.filter(Boolean).length, 1)
	assert.deepEqual((await pool.query('SELECT * FROM note WHERE note_id=$1', [f.note.note_id])).rows[0], f.note)
	assert.equal(await store.restore(f.boardId, receipt.token, f.actorId), null)
})

test('receipt insert failure rolls the note deletion back', async () => {
	const f = await fixture()
	await assert.rejects(store.remove(f.boardId, f.note.note_id, 'not-a-uuid'))
	assert.deepEqual((await pool.query('SELECT * FROM note WHERE note_id=$1', [f.note.note_id])).rows[0], f.note)
	assert.deepEqual(await store.list(f.boardId, f.actorId), [])
})

test('deletion through another existing board preserves both notes and mints no receipt', async () => {
	const f = await fixture()
	const other = await fixture()
	assert.equal(await store.remove(other.boardId, f.note.note_id, f.actorId), null)
	assert.deepEqual((await pool.query('SELECT * FROM note WHERE note_id=$1', [f.note.note_id])).rows[0], f.note)
	assert.deepEqual((await pool.query('SELECT * FROM note WHERE note_id=$1', [other.note.note_id])).rows[0], other.note)
	assert.deepEqual(await store.list(other.boardId, f.actorId), [])
	assert.deepEqual(await store.list(f.boardId, f.actorId), [])
})

test('expired receipts cannot restore or list a note and cleanup removes them', async () => {
	const f = await fixture()
	const { token } = await store.remove(f.boardId, f.note.note_id, f.actorId)
	const live = await fixture()
	const liveReceipt = await store.remove(live.boardId, live.note.note_id, live.actorId)
	await pool.query("UPDATE note_deletion SET expires_at=clock_timestamp()-interval '1 second' WHERE receipt_id=$1", [token])
	assert.deepEqual(await store.list(f.boardId, f.actorId), [])
	assert.equal(await store.restore(f.boardId, token, f.actorId), null)
	assert.equal((await pool.query('SELECT * FROM note_deletion WHERE receipt_id=$1', [token])).rowCount, 1)
	await store.prune()
	assert.equal((await pool.query('SELECT * FROM note_deletion WHERE receipt_id=$1', [token])).rowCount, 0)
	assert.equal((await pool.query('SELECT * FROM note_deletion WHERE receipt_id=$1', [liveReceipt.token])).rowCount, 1)
	assert.equal((await store.restore(live.boardId, liveReceipt.token, live.actorId)).note_id, live.note.note_id)
})

test('a concurrent replacement survives and consumes the obsolete receipt', async () => {
	const f = await fixture()
	const { token } = await store.remove(f.boardId, f.note.note_id, f.actorId)
	await pool.query(`INSERT INTO note SELECT * FROM jsonb_populate_record(NULL::note, $1::jsonb)`, [JSON.stringify({ ...f.note, content: 'Newer content' })])
	assert.equal(await store.restore(f.boardId, token, f.actorId), null)
	assert.equal((await pool.query('SELECT content FROM note WHERE note_id=$1', [f.note.note_id])).rows[0].content, 'Newer content')
	await pool.query('DELETE FROM note WHERE note_id=$1', [f.note.note_id])
	assert.equal(await store.restore(f.boardId, token, f.actorId), null)
})

test('board deletion cascades receipts and cannot resurrect its notes', async () => {
	const f = await fixture()
	const { token } = await store.remove(f.boardId, f.note.note_id, f.actorId)
	await pool.query('DELETE FROM board WHERE board_id=$1', [f.boardId])
	assert.equal(await store.restore(f.boardId, token, f.actorId), null)
	assert.equal((await pool.query('SELECT * FROM note_deletion WHERE receipt_id=$1', [token])).rowCount, 0)
})

test('competing deletions create exactly one receipt', async () => {
	const f = await fixture()
	const results = await Promise.all(Array.from({ length: 4 }, () => store.remove(f.boardId, f.note.note_id, f.actorId)))
	assert.equal(results.filter(Boolean).length, 1)
	assert.equal((await store.list(f.boardId, f.actorId)).length, 1)
})


test('a failed restore insert rolls receipt consumption back for retry', async () => {
	const f = await fixture()
	const { token } = await store.remove(f.boardId, f.note.note_id, f.actorId)
	await pool.query("UPDATE note_deletion SET snapshot=jsonb_set(snapshot, '{color}', '\"invalid\"') WHERE receipt_id=$1", [token])
	await assert.rejects(store.restore(f.boardId, token, f.actorId))
	assert.equal((await store.list(f.boardId, f.actorId)).length, 1)
	await pool.query('UPDATE note_deletion SET snapshot=$2 WHERE receipt_id=$1', [token, JSON.stringify(f.note)])
	assert.ok(await store.restore(f.boardId, token, f.actorId))
})

for (const action of ['remove', 'restore']) {
	test(`board deletion serializes with ${action} without a deadlock`, { timeout: 20_000 }, async (t) => {
		const f = await fixture()
		const token = action === 'restore' ? (await store.remove(f.boardId, f.note.note_id, f.actorId)).token : null
		const deletion = await pool.connect()
		const undo = await pool.connect()
		let operation
		try {
			await deletion.query("SET statement_timeout = '10s'")
			await undo.query("SET statement_timeout = '10s'")
			await deletion.query('BEGIN')
			// Pause the board sweep after it locks the parent, before cascading
			// into notes/receipts. Observe the real lock wait before continuing.
			await deletion.query('SELECT board_id FROM board WHERE board_id=$1 FOR UPDATE', [f.boardId])
			const competing = postgresNoteUndo(undo)
			operation = (action === 'remove'
				? competing.remove(f.boardId, f.note.note_id, f.actorId)
				: competing.restore(f.boardId, token, f.actorId))
				.then(value => ({ value }), error => ({ error }))
			const deadline = Date.now() + 5_000
			let blocked = false
			while (Date.now() < deadline) {
				const { rows: [row] } = await admin.query('SELECT pg_blocking_pids($1) AS blockers', [undo.processID])
				if (row.blockers.includes(deletion.processID)) { blocked = true; break }
				await delay(20)
			}
			assert.ok(blocked, 'the undo statement must reach its parent-row lock wait')
			const deleted = await deletion.query('DELETE FROM board WHERE board_id=$1', [f.boardId])
				.then(value => ({ value }), error => ({ error }))
			await deletion.query(deleted.error ? 'ROLLBACK' : 'COMMIT')
			const result = await operation
			t.diagnostic(JSON.stringify({ action, deleteError: deleted.error?.code ?? null, undoError: result.error?.code ?? null }))
			assert.equal(deleted.error?.code, undefined, 'board deletion must not deadlock or time out')
			assert.equal(result.error?.code, undefined, 'undo must not deadlock or time out')
			assert.equal(deleted.value.rowCount, 1)
			assert.equal(result.value, null, 'a deleted board cannot produce a note or receipt')
			assert.equal((await pool.query('SELECT 1 FROM note WHERE board_id=$1', [f.boardId])).rowCount, 0)
			assert.equal((await pool.query('SELECT 1 FROM note_deletion WHERE board_id=$1', [f.boardId])).rowCount, 0)
		} finally {
			await deletion.query('ROLLBACK')
			await operation
			await Promise.all([deletion.query('RESET statement_timeout'), undo.query('RESET statement_timeout')])
			deletion.release()
			undo.release()
		}
	})
}
