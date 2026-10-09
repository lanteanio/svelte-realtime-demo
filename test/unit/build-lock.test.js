import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { UNREADABLE_GRACE_MS, lockState, withBuildLock } from '../../scripts/build-lock.mjs'

const dead = () => false
const alive = () => true
const NOW = 1_785_482_486_622

// Fixture directories carry this process's pid, so the last test can tell
// this run's directories from those of another unit run sharing the temp
// directory. Any already there when the file loads (a pid reused from a run
// that was killed) are not counted.
const FIXTURE_PREFIX = `srd-lock-${process.pid}-`
const fixtureDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith(FIXTURE_PREFIX))
const preexisting = new Set(fixtureDirs())

// A lock path in a fresh directory that is removed when the test ends,
// whether it passed or failed.
function lockPath(t) {
	const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	return join(dir, 'srd-build.lock')
}

test('a lock held by a living process is respected', () => {
	assert.equal(lockState('4242\n2026-08-15T00:00:00.000Z\n', NOW, NOW, alive), 'held')
})

test('a lock whose holder is gone is reclaimable', () => {
	// The whole reason the lock can be automatic: a killed build must not
	// block every later build in the checkout until someone deletes a file
	// they do not know exists.
	assert.equal(lockState('4242\n', NOW, NOW, dead), 'stale')
})

test('an unwritten lock is respected briefly, then reclaimed', () => {
	// A builder creates the file and stamps it microseconds later. Inside that
	// window an empty lock is real and must be waited on; well outside it, the
	// writer died in the gap and nothing is coming.
	const written = NOW - UNREADABLE_GRACE_MS + 1
	assert.equal(lockState('', written, NOW, dead), 'held')
	assert.equal(lockState('', written, NOW, alive), 'held')
	const abandoned = NOW - UNREADABLE_GRACE_MS - 1
	assert.equal(lockState('', abandoned, NOW, alive), 'stale')
	assert.equal(lockState(null, abandoned, NOW, alive), 'stale')
	assert.equal(lockState('not a pid', abandoned, NOW, alive), 'stale')
})

test('a pid that is not a positive integer is not treated as a holder', () => {
	// Otherwise a corrupt lock would be probed as pid 0 or NaN, and pidAlive
	// answers "alive" to both by design - which here would mean blocking.
	const abandoned = NOW - UNREADABLE_GRACE_MS - 1
	for (const bad of ['0', '-1', '1.5', 'NaN']) {
		assert.equal(lockState(`${bad}\n`, abandoned, NOW, alive), 'stale', `pid ${bad}`)
	}
})

test('the lock is released even when the build throws', async (t) => {
	const path = lockPath(t)
	await assert.rejects(
		withBuildLock(path, async () => { throw new Error('vite exploded') }),
		/vite exploded/
	)
	assert.equal(existsSync(path), false, 'a failed build must not leave the next one waiting')
})

test('the lock records this process, and the next build reclaims a dead holder', async (t) => {
	const path = lockPath(t)
	let observed = ''
	const result = await withBuildLock(path, async () => {
		observed = readFileSync(path, 'utf8')
		return 'built'
	})
	assert.equal(result, 'built')
	assert.equal(Number(observed.split('\n')[0]), process.pid)

	// Now leave a lock owned by a pid that cannot be running and prove the next
	// build takes it rather than waiting out its timeout. A short timeout is
	// what makes this a real check: if the reclaim path were broken the call
	// would reject instead of resolving.
	writeFileSync(path, '2147483646\n2026-08-15T00:00:00.000Z\n')
	assert.equal(await withBuildLock(path, async () => 'reclaimed', { timeoutMs: 3000, log: () => {} }), 'reclaimed')
})

test('a build waiting on a live holder gives up with the holder named', async (t) => {
	const path = lockPath(t)
	// This process is unambiguously alive, so the lock can never be reclaimed
	// and the wait must end in an error rather than in a second build.
	writeFileSync(path, `${process.pid}\n2026-08-15T00:00:00.000Z\n`)
	let ran = false
	await assert.rejects(
		withBuildLock(path, async () => { ran = true }, { timeoutMs: 0, log: () => {} }),
		new RegExp(`pid ${process.pid} has held`)
	)
	assert.equal(ran, false, 'the body must not run while another build holds the lock')
})

test('an empty lock past the grace period is reclaimed rather than waited on forever', async (t) => {
	const path = lockPath(t)
	writeFileSync(path, '')
	const old = new Date(Date.now() - UNREADABLE_GRACE_MS - 60_000)
	utimesSync(path, old, old)
	assert.equal(await withBuildLock(path, async () => 'reclaimed', { timeoutMs: 3000, log: () => {} }), 'reclaimed')
})

test('no lock fixture outlives the test that made it', () => {
	// Declared last, and the tests in this file run one at a time in order, so
	// every test above has ended and run its after hooks. Looks only at
	// directories in tmpdir() whose names start with FIXTURE_PREFIX, at the
	// moment this test runs. Not looked at: a fixture made under another name
	// or in another directory, and one made again after this test, such as by
	// a timed-out test whose body is still running.
	const left = fixtureDirs().filter((name) => !preexisting.has(name))
	assert.deepEqual(left, [], `lock fixtures left in ${tmpdir()}`)
})
