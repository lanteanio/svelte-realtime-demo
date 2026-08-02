/**
 * Identifying harness containers whose creating run is gone.
 *
 * The e2e harness names every container it creates
 * `srd-test-<postgres|redis>-<pid>-<timestamp>`, so the name already records
 * who owns it and no side bookkeeping is needed. That matters because the
 * harness cannot rely on its own teardown: cleanup() covers normal exit and
 * SIGINT/SIGTERM, but a harder kill skips it, and the containers were found
 * still running 29 hours later.
 *
 * Split out from run-local-e2e.mjs so the selection rule can be tested. That
 * script runs its whole pipeline on import, so anything left inside it is
 * reachable only by running a full tier.
 */

/** `srd-test-postgres-12345-1785482486622` -> owning pid in group 1. */
export const HARNESS_CONTAINER = /^srd-test-(?:postgres|redis)-(\d+)-\d+$/

/**
 * True when the pid is still running.
 *
 * Deliberately conservative in both directions it can be wrong. A pid that
 * cannot be parsed is reported alive, so a container name this rule does not
 * understand is never swept. `EPERM` is alive too: it means the process exists
 * and belongs to someone else.
 *
 * @param {number} pid
 */
export function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error.code === 'EPERM'
	}
}

/**
 * Pick the container names whose owning run is dead.
 *
 * A recycled pid reads as alive and its container is kept, so the failure mode
 * is leaving a leak in place rather than deleting the database out from under
 * a running harness. That asymmetry is the point: concurrent runs are normal
 * here (the cluster tier starts two app instances, and a second tier can run
 * alongside), so "remove everything that is not mine" would be wrong.
 *
 * @param {string[]} names raw `docker ps` output lines
 * @param {(pid: number) => boolean} [isAlive] injectable for tests
 * @returns {string[]}
 */
export function selectOrphans(names, isAlive = pidAlive) {
	return names
		.map((name) => name.trim())
		.filter(Boolean)
		.filter((name) => {
			const owner = HARNESS_CONTAINER.exec(name)
			return owner ? !isAlive(Number(owner[1])) : false
		})
}
