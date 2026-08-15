import assert from 'node:assert/strict'
import test from 'node:test'
import { selectOrphans, ownerPid, pidAlive, HARNESS_BUILD_DIR, HARNESS_CONTAINER } from '../../scripts/orphan-sweep.mjs'

const dead = () => false
const alive = () => true

test('a container whose owning run is gone is swept', () => {
	const names = ['srd-test-postgres-64708-1785482486622', 'srd-test-redis-64708-1785482486622']
	assert.deepEqual(selectOrphans(names, dead), names)
})

test('a running harness keeps its containers', () => {
	// The consequence of getting this wrong is deleting the database out from
	// under a live tier, so it is asserted directly rather than implied by the
	// orphan case passing.
	const names = ['srd-test-postgres-999-1785482486622', 'srd-test-redis-999-1785482486622']
	assert.deepEqual(selectOrphans(names, alive), [])
})

test('only the dead run is swept when runs are concurrent', () => {
	const live = 'srd-test-postgres-500-1785482486622'
	const orphan = 'srd-test-postgres-400-1785481676633'
	const selected = selectOrphans([live, orphan], (pid) => pid === 500)
	assert.deepEqual(selected, [orphan])
})

test('containers this rule does not recognise are never swept', () => {
	// A foreign container must survive even when the liveness probe says the
	// world is dead, because the pid it would parse does not exist.
	const foreign = ['postgres', 'srd-test-postgres', 'srd-test-mysql-1-2', 'other-srd-test-redis-1-2', '']
	assert.deepEqual(selectOrphans(foreign, dead), [])
})

test('a build directory left by a dead run is swept, and a live run keeps its own', () => {
	// The build tree is a live dependency of the server serving out of it for
	// the whole tier, not just at boot, so removing one out from under a
	// running harness has the same weight as removing its database.
	const orphan = 'srd-build-400-1785481676633'
	const live = 'srd-build-500-1785482486622'
	assert.deepEqual(selectOrphans([orphan, live], (pid) => pid === 500), [orphan])
	assert.deepEqual(selectOrphans([live], alive), [])
})

test('directories this rule does not recognise are never swept', () => {
	// build-runs/ is the harness's own directory, but anything a person put
	// there by hand outlives the sweep.
	const foreign = ['build', 'srd-build', 'srd-build-abc-1', 'my-notes', 'srd-builder-1-2']
	assert.deepEqual(selectOrphans(foreign, dead), [])
})

test('one ownership rule reads both kinds of artifact', () => {
	assert.equal(ownerPid('srd-test-postgres-64708-1785482486622'), 64708)
	assert.equal(ownerPid('srd-build-64708-1785482486622'), 64708)
	assert.equal(ownerPid('srd-build-abc-1'), null)
	assert.equal(ownerPid('unrelated'), null)
	assert.equal(HARNESS_BUILD_DIR.exec('srd-build-7-1')[1], '7')
	// The two patterns stay disjoint: a container name must not read as a
	// build directory, or the wrong sweep would claim it.
	assert.equal(HARNESS_BUILD_DIR.exec('srd-test-redis-7-1'), null)
	assert.equal(HARNESS_CONTAINER.exec('srd-build-7-1'), null)
})

test('blank docker output selects nothing', () => {
	assert.deepEqual(selectOrphans(''.split(/\r?\n/), dead), [])
	assert.deepEqual(selectOrphans(['  ', '\t'], dead), [])
})

test('carriage returns and padding from docker output are tolerated', () => {
	const name = 'srd-test-redis-64708-1785482486622'
	assert.deepEqual(selectOrphans([`  ${name}  `], dead), [name])
})

test('the name pattern captures the owning pid', () => {
	assert.equal(HARNESS_CONTAINER.exec('srd-test-postgres-64708-1785482486622')[1], '64708')
	assert.equal(HARNESS_CONTAINER.exec('srd-test-redis-7-1')[1], '7')
	assert.equal(HARNESS_CONTAINER.exec('srd-test-postgres-abc-1'), null)
})

test('pidAlive reports this process alive and refuses to guess at bad input', () => {
	assert.equal(pidAlive(process.pid), true)
	// Unparseable input errs toward alive so an unrecognised name is kept.
	for (const bad of [NaN, 0, -1, 1.5]) assert.equal(pidAlive(bad), true)
})

test('pidAlive reports an unused pid dead', () => {
	// Search downward from a high pid for one that is genuinely absent, so the
	// test does not depend on any particular pid being free.
	let absent = null
	for (let candidate = 0x7ffffffe; candidate > 0x7ffff000; candidate--) {
		try {
			process.kill(candidate, 0)
		} catch (error) {
			if (error.code === 'ESRCH') { absent = candidate; break }
		}
	}
	assert.notEqual(absent, null, 'expected to find an unused pid')
	assert.equal(pidAlive(absent), false)
})
