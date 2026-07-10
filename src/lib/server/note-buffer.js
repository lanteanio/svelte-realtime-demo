/**
 * Acknowledge one persisted drag-buffer generation.
 *
 * DB-side fields are refreshed from the UPDATE result, while x/y remain the
 * latest in-memory coordinates. Only the exact snapshotted generation becomes
 * clean; moves that arrived during the write remain dirty for the next flush.
 */
export function acknowledgeNoteFlush(entry, persistedVersion, fresh) {
	entry.note = { ...fresh, x: entry.note.x, y: entry.note.y }
	if (entry.version === persistedVersion) entry.dirty = false
}

/** Merge a non-position DB mutation without discarding a buffered drag. */
export function mergeNoteMutation(entry, fresh) {
	entry.note = { ...fresh, x: entry.note.x, y: entry.note.y }
}

/**
 * Reconcile a batch position write with moves that may have raced it.
 *
 * If no move arrived, the batch coordinates become the cache value. If a
 * later move arrived, its coordinates win. Either way a new generation stays
 * dirty so an older in-flight flush cannot be the final database writer.
 */
export function reconcileBatchPosition(entry, versionAtStart, fresh) {
	if (versionAtStart === undefined || entry.version !== versionAtStart) {
		entry.note = { ...fresh, x: entry.note.x, y: entry.note.y }
	} else {
		entry.note = fresh
	}
	entry.version++
	entry.dirty = true
	return entry.note
}
