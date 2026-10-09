/**
 * Cascading-column layout for the board's group arrangements (by color, by
 * author).
 *
 * Each group cascades down a column, 4 px right and 35 px down per note, so
 * every card's header stays readable. A group longer than PER_COLUMN continues
 * in the next column. Columns run left to right, and one that would cross the
 * board's right edge starts a new row of columns below the deepest column of
 * the row before.
 *
 * Every coordinate is clamped into LIMITS.COORD_MIN..COORD_MAX, the bounds the
 * note table's check constraints enforce, because the arrangement is written in
 * one statement and a single row out of bounds fails all of it. The board runs
 * out of rows at about 8,300 notes in full columns, and at about 1,860 groups
 * when every group is a single note; notes past that point are held at the
 * bottom edge rather than failing the arrangement.
 */

import { LIMITS } from './validate.js'

export const PER_COLUMN = 20
const START_X = 40
const START_Y = 40
// A note is 208 px wide (w-52); the rest is the gap between columns.
const COLUMN_PITCH = 260
const CASCADE_X = 4
const CASCADE_Y = 35
// A note's minimum height (min-h-36), and the gap between rows of columns.
const NOTE_HEIGHT = 144
const ROW_GAP = 60

const clamp = (value) => Math.max(LIMITS.COORD_MIN, Math.min(LIMITS.COORD_MAX, value))

/**
 * Lay out groups of notes in cascading columns, in the order given.
 *
 * @param {Iterable<Array<{ note_id: string }>>} groups
 * @returns {Array<{ note_id: string, x: number, y: number, z_index: number }>}
 */
export function cascadeColumns(groups) {
	const updates = []
	let column = 0
	let rowY = START_Y
	let rowDepth = 0
	for (const group of groups) {
		for (let start = 0; start < group.length; start += PER_COLUMN) {
			const notes = group.slice(start, start + PER_COLUMN)
			let x = START_X + column * COLUMN_PITCH
			if (column > 0 && x + (notes.length - 1) * CASCADE_X + COLUMN_PITCH > LIMITS.COORD_MAX) {
				rowY += (rowDepth - 1) * CASCADE_Y + NOTE_HEIGHT + ROW_GAP
				column = 0
				rowDepth = 0
				x = START_X
			}
			for (let i = 0; i < notes.length; i++) {
				updates.push({
					note_id: notes[i].note_id,
					x: clamp(x + i * CASCADE_X),
					y: clamp(rowY + i * CASCADE_Y),
					z_index: updates.length
				})
			}
			rowDepth = Math.max(rowDepth, notes.length)
			column++
		}
	}
	return updates
}
