import assert from 'node:assert/strict'
import test from 'node:test'
import {
	acknowledgeNoteFlush,
	mergeNoteMutation,
	reconcileBatchPosition
} from '../../src/lib/server/note-buffer.js'

test('exact persisted note generation becomes clean', () => {
	const entry = {
		note: { note_id: 'n1', content: 'old', x: 410, y: 330 },
		version: 3,
		dirty: true
	}

	acknowledgeNoteFlush(entry, 3, { note_id: 'n1', content: 'fresh', x: 290, y: 250 })
	assert.equal(entry.dirty, false)
	assert.deepEqual(entry.note, { note_id: 'n1', content: 'fresh', x: 410, y: 330 })
})

test('new move during a write remains dirty for the next flush', () => {
	const entry = {
		note: { note_id: 'n1', content: 'old', x: 500, y: 400 },
		version: 4,
		dirty: true
	}

	acknowledgeNoteFlush(entry, 3, { note_id: 'n1', content: 'fresh', x: 410, y: 330 })
	assert.equal(entry.dirty, true)
	assert.deepEqual(entry.note, { note_id: 'n1', content: 'fresh', x: 500, y: 400 })
})

test('failed write leaves the entry dirty when no acknowledgement occurs', () => {
	const entry = { note: { x: 410, y: 330 }, version: 2, dirty: true }
	assert.equal(entry.dirty, true)
})

test('edit result preserves a newer buffered position and dirty generation', () => {
	const entry = {
		note: { note_id: 'n1', content: 'old', color: '#fef08a', x: 500, y: 400 },
		version: 4,
		dirty: true
	}

	mergeNoteMutation(entry, {
		note_id: 'n1', content: 'edited', color: '#bfdbfe', x: 200, y: 200
	})
	assert.deepEqual(entry.note, {
		note_id: 'n1', content: 'edited', color: '#bfdbfe', x: 500, y: 400
	})
	assert.equal(entry.version, 4)
	assert.equal(entry.dirty, true)
})

test('batch wins when no move races the captured generation', () => {
	const entry = { note: { note_id: 'n1', x: 500, y: 400 }, version: 4, dirty: false }
	reconcileBatchPosition(entry, 4, { note_id: 'n1', x: 40, y: 40 })
	assert.deepEqual(entry.note, { note_id: 'n1', x: 40, y: 40 })
	assert.equal(entry.version, 5)
	assert.equal(entry.dirty, true)
})

test('move after a batch snapshot wins and remains durable', () => {
	const entry = { note: { note_id: 'n1', x: 700, y: 650 }, version: 5, dirty: true }
	reconcileBatchPosition(entry, 4, { note_id: 'n1', x: 40, y: 40 })
	assert.deepEqual(entry.note, { note_id: 'n1', x: 700, y: 650 })
	assert.equal(entry.version, 6)
	assert.equal(entry.dirty, true)
})
