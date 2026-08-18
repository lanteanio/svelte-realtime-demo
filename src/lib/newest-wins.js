/**
 * Keep the newest observation of each record, regardless of arrival order.
 *
 * A stream that publishes ABSOLUTE values from several replicas cannot be
 * merged by arrival. Each replica publishes the value it observed, and
 * `merge: 'crud'` replaces by key as frames land - so two clicks served by
 * different replicas reach two clients in opposite orders, and the client that
 * happens to receive the higher value first ends up displaying the lower one.
 * It stays there: those two publishes are all there will ever be, so nothing
 * later corrects it. The divergence is terminal rather than transient.
 *
 * The wire already carries what orders them. `modifiedAt` is stamped inside the
 * Redis script that performs the write, so every replica reads ONE clock no
 * matter which instance served the click, and it totally orders the events -
 * unlike the envelope's `seq`, which numbers per-subscriber delivery and is
 * therefore a different number on each client for the same logical event.
 *
 * Value breaks a same-millisecond tie: on a counter that only ever rises, the
 * higher count is necessarily the later of the two. A reset is ordered by the
 * same rule rather than special-cased - it carries a fresh stamp, so it wins
 * and still shows zero.
 *
 * Stateful on purpose. The gate has to remember what it has already seen,
 * because the stale frame arrives as a REPLACEMENT for the only row that key
 * has; filtering within a single emission would see nothing to compare.
 */
export function createNewestWins() {
	/** @type {Map<string, any>} */
	const newest = new Map()
	return function accept(list) {
		for (const row of Array.isArray(list) ? list : []) {
			if (!row || row.id === undefined) continue
			const held = newest.get(row.id)
			if (!held) { newest.set(row.id, row); continue }
			const heldAt = held.modifiedAt ?? 0
			const rowAt = row.modifiedAt ?? 0
			const newer = rowAt > heldAt || (rowAt === heldAt && (row.value ?? 0) >= (held.value ?? 0))
			if (newer) newest.set(row.id, row)
		}
		return [...newest.values()]
	}
}
