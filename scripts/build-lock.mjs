/**
 * One build at a time in this checkout.
 *
 * `vite build` is not the isolated step it looks like: it shares
 * `.svelte-kit/` and Vite's own transform cache with every other build in the
 * same working tree. Two of them at once corrupt each other in ways that read
 * as a broken source file rather than as interference - a build that failed
 * this way reported `failed to load virtual css module` for a component, then
 * handed Tailwind the component's RAW source, so its leading HTML comment was
 * parsed as a CSS declaration. The component was unmodified and structurally
 * fine. Anyone reading that message goes looking for a corrupt component and
 * finds nothing wrong with it.
 *
 * This checkout routinely has two sessions in it, so serialising is the fix:
 * a second build waits for the first rather than racing it. Waiting costs a
 * minute; the alternative costs a wrong answer that looks like a code fault.
 *
 * OWNERSHIP IS THE PID, the same convention the harness containers and the
 * per-run build directories use. A lock whose holder is gone is reclaimed
 * automatically, so a killed build cannot block this checkout forever and no
 * one has to know the lock exists to recover from one.
 */

import { mkdirSync, openSync, closeSync, writeSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pidAlive } from './orphan-sweep.mjs'

/**
 * How long an unreadable lock is respected before it is reclaimed.
 *
 * A live builder writes its pid microseconds after creating the file, so an
 * empty or unparseable lock older than this was left by a writer killed inside
 * that window. Without the grace period such a lock would block every build in
 * the checkout until someone deleted it by hand, which is exactly the kind of
 * failure nobody can diagnose without knowing the lock exists.
 */
export const UNREADABLE_GRACE_MS = 30_000

/**
 * What an existing lock file means right now.
 *
 * Pure, so the decision can be tested without racing real processes: the IO
 * loop below is a thin wrapper over this.
 *
 * @param {string | null} contents the lock file's text, null if unreadable
 * @param {number} mtimeMs when it was last written
 * @param {number} now
 * @param {(pid: number) => boolean} isAlive
 * @returns {'held' | 'stale'}
 */
export function lockState(contents, mtimeMs, now, isAlive) {
	const pid = Number(String(contents ?? '').split('\n')[0].trim())
	if (Number.isInteger(pid) && pid > 0) return isAlive(pid) ? 'held' : 'stale'
	return now - mtimeMs > UNREADABLE_GRACE_MS ? 'stale' : 'held'
}

/**
 * Run `body` with the build lock held, waiting for any other build first.
 *
 * The lock is always released, including when the body throws, so a failed
 * build does not leave the next one waiting out the grace period.
 *
 * @template T
 * @param {string} path lock file path
 * @param {() => Promise<T>} body
 * @param {{ timeoutMs?: number, log?: (message: string) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withBuildLock(path, body, options = {}) {
	const { timeoutMs = 900_000, log = console.log } = options
	const deadline = Date.now() + timeoutMs
	let announced = false

	mkdirSync(dirname(path), { recursive: true })
	for (;;) {
		if (tryAcquire(path)) break
		const holder = describeHolder(path)
		if (holder === 'stale') {
			// Reclaim and retry rather than taking the lock here: another waiter
			// may reclaim it first, and the exclusive create is what decides
			// between us. Unlinking a lock we do not own is safe for the same
			// reason - it is already established that nothing holds it.
			try { unlinkSync(path) } catch { /* another waiter got there first */ }
			continue
		}
		if (!announced) {
			log(`build lock: waiting for the build held by pid ${holder}`)
			announced = true
		}
		if (Date.now() >= deadline) {
			throw new Error(`build lock: pid ${holder} has held ${path} for over ${Math.round(timeoutMs / 1000)}s`)
		}
		await delay(1000)
	}

	try {
		return await body()
	} finally {
		try { unlinkSync(path) } catch { /* already reclaimed by a waiter */ }
	}
}

/**
 * Create the lock exclusively and stamp it with this pid. `wx` is the whole
 * mutual exclusion: the filesystem decides, so two builders starting in the
 * same millisecond cannot both succeed.
 *
 * @param {string} path
 */
function tryAcquire(path) {
	let fd
	try {
		fd = openSync(path, 'wx')
	} catch (error) {
		if (error.code === 'EEXIST') return false
		throw error
	}
	try {
		writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`)
	} finally {
		closeSync(fd)
	}
	return true
}

/**
 * The pid holding the lock, or 'stale' when it can be reclaimed. A lock that
 * vanishes between the two syscalls reads as stale, which is what it is. A
 * holder still inside the grace period may not have written its pid yet, so
 * the identity is reported as unknown rather than as a fabricated number.
 *
 * @param {string} path
 * @returns {number | 'unknown' | 'stale'}
 */
function describeHolder(path) {
	let contents = null
	let mtimeMs = 0
	try {
		contents = readFileSync(path, 'utf8')
		mtimeMs = statSync(path).mtimeMs
	} catch (error) {
		if (error.code === 'ENOENT') return 'stale'
	}
	if (lockState(contents, mtimeMs, Date.now(), pidAlive) === 'stale') return 'stale'
	const pid = Number(String(contents ?? '').split('\n')[0].trim())
	return Number.isInteger(pid) && pid > 0 ? pid : 'unknown'
}
