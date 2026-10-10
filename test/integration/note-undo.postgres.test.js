import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

test('expired receipts cannot restore or list a note and cleanup removes them', async () => {
	const f = await fixture()
	const { token } = await store.remove(f.boardId, f.note.note_id, f.actorId)
	await pool.query("UPDATE note_deletion SET expires_at=clock_timestamp()-interval '1 second' WHERE receipt_id=$1", [token])
	assert.deepEqual(await store.list(f.boardId, f.actorId), [])
	assert.equal(await store.restore(f.boardId, token, f.actorId), null)
	await store.prune()
	assert.equal((await pool.query('SELECT * FROM note_deletion WHERE receipt_id=$1', [token])).rowCount, 0)
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
