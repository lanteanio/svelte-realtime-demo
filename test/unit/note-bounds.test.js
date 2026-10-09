import assert from 'node:assert/strict'
import test from 'node:test'
import { assertNoteCoords } from '../../src/lib/server/note-bounds.js'

const violation = (axis) => ({ code: '23514', message: new RegExp(`note_${axis}_check`) })

test('a row on the edge of the board passes', () => {
	assert.doesNotThrow(() => assertNoteCoords([{ x: -10000, y: 10000 }, { x: 10000, y: -10000 }, { x: 0, y: 0 }]))
})

test('a row past an edge is refused the way Postgres refuses it', () => {
	assert.throws(() => assertNoteCoords([{ x: 10001, y: 0 }]), violation('x'))
	assert.throws(() => assertNoteCoords([{ x: -10001, y: 0 }]), violation('x'))
	assert.throws(() => assertNoteCoords([{ x: 0, y: 10925 }]), violation('y'))
	assert.throws(() => assertNoteCoords([{ x: 0, y: -10001 }]), violation('y'))
	assert.throws(() => assertNoteCoords([{ x: 0, y: Number.NaN }]), violation('y'))
})

test('one row past an edge refuses the whole batch', () => {
	assert.throws(() => assertNoteCoords([{ x: 40, y: 40 }, { x: 44, y: 10155 }, { x: 48, y: 110 }]), violation('y'))
})

test('a field that is not being written is not checked', () => {
	assert.doesNotThrow(() => assertNoteCoords([{ content: 'edited' }, { x: 5 }, { y: 5 }]))
})
