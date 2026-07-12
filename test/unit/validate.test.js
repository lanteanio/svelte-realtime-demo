import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	validateBoardFields,
	validateBoardTitle,
	validateCoord,
	validateNoteFields,
	validateZIndex
} from '../../src/lib/server/validate.js'

test('board titles are trimmed and bounded', () => {
	assert.equal(validateBoardTitle('  Planning  '), 'Planning')
	assert.throws(() => validateBoardTitle('   '), /Title required/)
	assert.throws(() => validateBoardTitle('x'.repeat(101)), /100 characters or less/)
})

test('coordinates are finite, rounded, and clamped', () => {
	assert.equal(validateCoord(4.6, 'x'), 5)
	assert.equal(validateCoord(50_000, 'x'), 10_000)
	assert.equal(validateCoord(-50_000, 'y'), -10_000)
	assert.throws(() => validateCoord('not-a-number', 'x'), /must be a number/)
})

test('field validators allowlist known properties', () => {
	assert.deepEqual(validateBoardFields({ title: ' Demo ', ignored: true }), { title: 'Demo' })
	assert.deepEqual(
		validateNoteFields({ content: 'hello', color: '#abcdef', x: 50, y: 60, z_index: 9, ignored: true }),
		{ content: 'hello', color: '#abcdef' }
	)
})

test('z-index rejects negative and non-finite values', () => {
	assert.equal(validateZIndex(3.6), 4)
	assert.throws(() => validateZIndex(-1), /non-negative/)
	assert.throws(() => validateZIndex(Infinity), /non-negative/)
})
