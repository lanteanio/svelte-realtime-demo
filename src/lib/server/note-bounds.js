/**
 * The note table's coordinate check constraints (note_x_check, note_y_check)
 * as a function, for the in-memory dev store, so it refuses the rows Postgres
 * refuses. Every row is checked before the first is reported: in Postgres one
 * statement fails whole, so a caller checks a batch before writing any of it.
 */

import { LIMITS } from './validate.js'

/**
 * Throw, as Postgres does for a check violation (code 23514), when any row's
 * x or y lies outside LIMITS.COORD_MIN..COORD_MAX. An absent x or y is not
 * checked.
 *
 * @param {Iterable<{ x?: number, y?: number, [field: string]: unknown }>} rows
 */
export function assertNoteCoords(rows) {
	for (const row of rows) {
		for (const axis of /** @type {const} */ (['x', 'y'])) {
			const value = row[axis]
			if (value !== undefined && !(value >= LIMITS.COORD_MIN && value <= LIMITS.COORD_MAX)) {
				throw Object.assign(new Error(`new row for relation "note" violates check constraint "note_${axis}_check"`), { code: '23514' })
			}
		}
	}
}
