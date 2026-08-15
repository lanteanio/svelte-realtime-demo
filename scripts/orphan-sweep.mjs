/**
 * Identifying harness artifacts whose creating run is gone.
 *
 * The e2e harness names everything it creates after the run that created it -
 * `srd-test-<postgres|redis>-<pid>-<timestamp>` for containers,
 * `srd-build-<pid>-<timestamp>` for the directory a run builds and serves from
 * - so the name already records who owns it and no side bookkeeping is needed.
 * That matters because the harness cannot rely on its own teardown: cleanup()
 * covers normal exit and SIGINT/SIGTERM, but a harder kill skips it, and the
 * containers were found still running 29 hours later.
 *
 * Split out from run-local-e2e.mjs so the selection rule can be tested. That
 * script runs its whole pipeline on import, so anything left inside it is
 * reachable only by running a full tier.
 */

/** `srd-test-postgres-12345-1785482486622` -> owning pid in group 1. */
export const HARNESS_CONTAINER = /^srd-test-(?:postgres|redis)-(\d+)-\d+$/

/** `srd-build-12345-1785482486622` -> owning pid in group 1. */
export const HARNESS_BUILD_DIR = /^srd-build-(\d+)-\d+$/

/**
 * The owning pid of a harness artifact, or null for a name this rule does not
 * recognise. One rule for both kinds: they carry the same suffix by design, so
 * a directory left by a dead run is reclaimed on exactly the evidence its
 * containers are.
 *
 * @param {string} name
 * @returns {number | null}
 */
export function ownerPid(name) {
	for (const pattern of [HARNESS_CONTAINER, HARNESS_BUILD_DIR]) {
		const owner = pattern.exec(name)
		if (owner) return Number(owner[1])
	}
	return null
}

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
 * Pick the artifact names whose owning run is dead.
 *
 * A recycled pid reads as alive and its artifact is kept, so the failure mode
 * is leaving a leak in place rather than deleting the database - or the served
 * build - out from under a running harness. That asymmetry is the point:
 * concurrent runs are normal here (the cluster tier starts two app instances,
 * and a second tier can run alongside), so "remove everything that is not
 * mine" would be wrong.
 *
 * @param {string[]} names raw `docker ps` output lines, or directory names
 * @param {(pid: number) => boolean} [isAlive] injectable for tests
 * @returns {string[]}
 */
export function selectOrphans(names, isAlive = pidAlive) {
	return names
		.map((name) => name.trim())
		.filter(Boolean)
		.filter((name) => {
			const owner = ownerPid(name)
			return owner === null ? false : !isAlive(owner)
		})
}
