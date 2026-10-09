import assert from 'node:assert/strict'
import test from 'node:test'
import { cascadeColumns, PER_COLUMN } from '../../src/lib/server/board-layout.js'
import { LIMITS } from '../../src/lib/server/validate.js'

const notes = (count, tag = 'n') => Array.from({ length: count }, (_, i) => ({ note_id: `${tag}${i}` }))
const at = (updates) => updates.map(({ x, y }) => [x, y])

test('a group that fits one column lands where the single-column layout put it', () => {
	const updates = cascadeColumns([notes(3, 'a'), notes(2, 'b')])
	assert.deepEqual(updates, [
		{ note_id: 'a0', x: 40, y: 40, z_index: 0 },
		{ note_id: 'a1', x: 44, y: 75, z_index: 1 },
		{ note_id: 'a2', x: 48, y: 110, z_index: 2 },
		{ note_id: 'b0', x: 300, y: 40, z_index: 3 },
		{ note_id: 'b1', x: 304, y: 75, z_index: 4 }
	])
})

test('a column holds twenty notes, and the twenty-first starts the next column', () => {
	const updates = cascadeColumns([notes(21)])
	assert.deepEqual(at([updates[19]]), [[40 + 19 * 4, 40 + 19 * 35]])
	assert.deepEqual(at([updates[20]]), [[300, 40]])
})

test('a group longer than a column continues in the next one', () => {
	const updates = cascadeColumns([notes(PER_COLUMN * 2 + 5)])
	assert.deepEqual(updates[PER_COLUMN - 1], { note_id: `n${PER_COLUMN - 1}`, x: 40 + (PER_COLUMN - 1) * 4, y: 40 + (PER_COLUMN - 1) * 35, z_index: PER_COLUMN - 1 })
	assert.deepEqual(at([updates[PER_COLUMN]]), [[300, 40]])
	assert.deepEqual(at([updates.at(-1)]), [[560 + 4 * 4, 40 + 4 * 35]])
})

test('a column that would cross the right edge starts a row below the deepest column', () => {
	// 38 columns fit across: the last at x 9660, whose cascade ends inside the
	// board. The 39th starts a new row, below the first row's deepest column.
	const shallow = cascadeColumns(Array.from({ length: 39 }, (_, g) => notes(1, `g${g}-`)))
	assert.deepEqual(at([shallow[37]]), [[9660, 40]])
	assert.deepEqual(at([shallow[38]]), [[40, 40 + 144 + 60]])
	const deep = cascadeColumns([notes(PER_COLUMN, 'deep'), ...Array.from({ length: 38 }, (_, g) => notes(1, `g${g}-`))])
	assert.deepEqual(at([deep.at(-1)]), [[40, 40 + (PER_COLUMN - 1) * 35 + 144 + 60]])
})

test('the board that failed fits: 312 notes in one group and 7 in others', () => {
	const updates = cascadeColumns([notes(312, 'y'), notes(3, 'b'), notes(1, 'g'), notes(1, 'p'), notes(1, 'o'), notes(1, 'v')])
	assert.equal(updates.length, 319)
	assert.ok(Math.max(...updates.map((u) => u.y)) <= 40 + (PER_COLUMN - 1) * 35, 'one row of columns holds it')
})

test('every coordinate stays inside the board, whatever the note count', () => {
	const shapes = [
		[notes(1)], [notes(285)], [notes(286)], [notes(1000)], [notes(8000)], [notes(20000)],
		Array.from({ length: 500 }, (_, g) => notes(1, `g${g}-`)),
		Array.from({ length: 100 }, (_, g) => notes(300, `g${g}-`))
	]
	for (const groups of shapes) {
		const total = groups.reduce((sum, group) => sum + group.length, 0)
		const updates = cascadeColumns(groups)
		assert.equal(updates.length, total)
		for (const [i, u] of updates.entries()) {
			assert.equal(u.z_index, i)
			for (const value of [u.x, u.y]) {
				assert.ok(Number.isInteger(value) && value >= LIMITS.COORD_MIN && value <= LIMITS.COORD_MAX,
					`${total} notes in ${groups.length} group(s): ${u.note_id} at ${u.x},${u.y}`)
			}
		}
	}
})
