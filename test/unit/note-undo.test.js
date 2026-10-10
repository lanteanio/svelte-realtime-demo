import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryNoteUndo, NOTE_UNDO_MS } from '../../src/lib/server/note-undo.js'
import { isBoardUndoShortcut } from '../../src/lib/client/board-undo.js'

function fixture() {
	let time = 1000
	const boardId = crypto.randomUUID()
	const actorId = crypto.randomUUID()
	const note = { note_id: crypto.randomUUID(), board_id: boardId, content: 'Remember this', x: 240, y: 180, color: '#bfdbfe', creator_name: 'Visitor', z_index: 7, is_archived: false, created_at: 10 }
	const boards = new Map([[boardId, {}]])
	const notes = new Map([[note.note_id, structuredClone(note)]])
	return { boardId, actorId, note, boards, notes, store: memoryNoteUndo(boards, notes, () => time), advance: (ms) => { time += ms } }
}

test('deleting and restoring preserves the full note and consumes the receipt', () => {
	const f = fixture()
	const receipt = f.store.remove(f.boardId, f.note.note_id, f.actorId)
	assert.equal(f.notes.has(f.note.note_id), false)
	assert.equal(receipt.expiresAt, 1000 + NOTE_UNDO_MS)
	assert.deepEqual(f.store.list(f.boardId, f.actorId), [receipt])
	assert.equal(f.store.restore(f.boardId, receipt.token, f.actorId).note_id, f.note.note_id)
	assert.deepEqual(f.notes.get(f.note.note_id), f.note)
	assert.deepEqual(f.store.list(f.boardId, f.actorId), [])
	assert.equal(f.store.restore(f.boardId, receipt.token, f.actorId), null)
})

test('foreign visitor and board cannot list or consume the deletion', () => {
	const f = fixture()
	const token = f.store.remove(f.boardId, f.note.note_id, f.actorId).token
	for (const [board, actor] of [[crypto.randomUUID(), f.actorId], [f.boardId, crypto.randomUUID()]]) {
		assert.deepEqual(f.store.list(board, actor), [])
		assert.equal(f.store.restore(board, token, actor), null)
	}
	assert.ok(f.store.restore(f.boardId, token, f.actorId))
})

test('undo accepts just before expiry and refuses the exact boundary', () => {
	for (const [elapsed, allowed] of [[NOTE_UNDO_MS - 1, true], [NOTE_UNDO_MS, false]]) {
		const f = fixture()
		const token = f.store.remove(f.boardId, f.note.note_id, f.actorId).token
		f.advance(elapsed)
		assert.equal(f.store.list(f.boardId, f.actorId).length, allowed ? 1 : 0)
		assert.equal(Boolean(f.store.restore(f.boardId, token, f.actorId)), allowed)
	}
})

test('an existing note wins and a conflicting receipt cannot revive later', () => {
	const f = fixture()
	const token = f.store.remove(f.boardId, f.note.note_id, f.actorId).token
	const newer = { ...f.note, content: 'Newer content' }
	f.notes.set(f.note.note_id, newer)
	assert.equal(f.store.restore(f.boardId, token, f.actorId), null)
	assert.deepEqual(f.notes.get(f.note.note_id), newer)
	f.notes.delete(f.note.note_id)
	assert.equal(f.store.restore(f.boardId, token, f.actorId), null)
})

test('a deleted board cannot be restored through a receipt', () => {
	const f = fixture()
	const token = f.store.remove(f.boardId, f.note.note_id, f.actorId).token
	f.boards.delete(f.boardId)
	assert.equal(f.store.restore(f.boardId, token, f.actorId), null)
	assert.equal(f.notes.size, 0)
})

test('wrong-board and repeated deletion do not mint receipts', () => {
	const f = fixture()
	assert.equal(f.store.remove(crypto.randomUUID(), f.note.note_id, f.actorId), null)
	assert.ok(f.notes.has(f.note.note_id))
	assert.ok(f.store.remove(f.boardId, f.note.note_id, f.actorId))
	assert.equal(f.store.remove(f.boardId, f.note.note_id, f.actorId), null)
	assert.equal(f.store.list(f.boardId, f.actorId).length, 1)
})

test('board undo shortcut excludes editing, redo and handled keys', () => {
	const base = { key: 'z', ctrlKey: true, target: { closest: () => null } }
	assert.equal(isBoardUndoShortcut(base), true)
	assert.equal(isBoardUndoShortcut({ ...base, key: 'Z', ctrlKey: false, metaKey: true }), true)
	for (const fields of [{ ctrlKey: false }, { key: 'y' }, { shiftKey: true }, { altKey: true }, { repeat: true }, { defaultPrevented: true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }]) {
		assert.equal(isBoardUndoShortcut({ ...base, ...fields }), false, JSON.stringify(fields))
	}
})


test('deletions within one clock millisecond list the newest receipt first', () => {
	const f = fixture()
	const second = { ...f.note, note_id: crypto.randomUUID() }
	f.notes.set(second.note_id, second)
	const firstReceipt = f.store.remove(f.boardId, f.note.note_id, f.actorId)
	const secondReceipt = f.store.remove(f.boardId, second.note_id, f.actorId)
	assert.deepEqual(f.store.list(f.boardId, f.actorId).map((item) => item.token), [secondReceipt.token, firstReceipt.token])
})
