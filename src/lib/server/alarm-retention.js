/**
 * Age retention for the alarms demo's fired log, kept pure so the boundary
 * is unit-testable without Redis behind it.
 */

/** How long a fired record stays on the log. One day, exactly the horizon
 * the purge module's exclusion comment already promised for this demo. */
export const RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * Split parsed fired records into the ones still inside the retention
 * window and the ones past it. A record exactly RETENTION_MS old is STALE -
 * the window is "less than a day old", not "up to and including" - and
 * records whose firedAt is missing or unreadable count as stale rather than
 * surviving forever on the strength of a field they do not have.
 * @param {Array<{ entry: any, raw: string }>} records parsed with their raw form
 * @param {number} now epoch ms
 * @returns {{ fresh: Array<{ entry: any, raw: string }>, stale: Array<{ entry: any, raw: string }> }}
 */
export function partitionFired(records, now) {
	const fresh = []
	const stale = []
	for (const record of records) {
		const firedAt = record.entry?.firedAt
		const alive = typeof firedAt === 'number' && Number.isFinite(firedAt) && now - firedAt < RETENTION_MS
		if (alive) fresh.push(record)
		else stale.push(record)
	}
	return { fresh, stale }
}
