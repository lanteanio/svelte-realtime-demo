/**
 * Execute a callback while holding a PostgreSQL session advisory lock.
 * Kept independent of SvelteKit environment imports so lifecycle edge cases
 * can be covered with focused unit tests.
 *
 * @param {any} pool
 * @param {number} lockId
 * @param {(client: any) => any | Promise<any>} criticalSection
 * @param {{ warn?: (...args: any[]) => void, error?: (...args: any[]) => void }} logger
 */
export async function runWithAdvisoryLock(pool, lockId, criticalSection, logger = console) {
	if (typeof criticalSection !== 'function') {
		throw new TypeError('criticalSection must be a function')
	}
	if (!pool) return criticalSection(null)

	const client = await pool.connect()
	let acquired = false
	let result
	let operationError = null
	let unlockError = null
	try {
		const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId])
		acquired = rows[0]?.acquired === true
		if (acquired) result = await criticalSection(client)
	} catch (err) {
		operationError = err
	} finally {
		if (acquired) {
			try {
				const { rows } = await client.query('SELECT pg_advisory_unlock($1) AS released', [lockId])
				if (rows[0]?.released !== true) {
					logger.warn?.(`[postgres] advisory lock ${lockId} was not held during release`)
				}
			} catch (err) {
				unlockError = err
			}
		}
		// Exactly one release call. Passing the unlock error tells pg to
		// discard a broken client rather than put it back into circulation.
		client.release(unlockError ?? undefined)
	}

	// Preserve a critical-section failure if unlock also failed; report the
	// cleanup problem without masking the original application error.
	if (operationError) {
		if (unlockError) {
			logger.error?.('[postgres] advisory unlock also failed', {
				name: unlockError?.name,
				code: unlockError?.code
			})
		}
		throw operationError
	}
	if (unlockError) throw unlockError
	return result
}
