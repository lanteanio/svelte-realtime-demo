import assert from 'node:assert/strict'
import test from 'node:test'
import { createNewestWins } from '../../src/lib/newest-wins.js'

// The failure this exists for, taken from the wire capture: two clients each
// click bump on a different replica, both receive both publishes, in opposite
// orders. Absolute values merged by arrival leave the two clients showing
// different numbers permanently, because those two publishes are all there
// will ever be.
const one = { id: 'alpha', value: 1, modifiedAt: 1000 }
const two = { id: 'alpha', value: 2, modifiedAt: 1001 }

test('two clients receiving the same publishes in opposite orders converge', () => {
	const clientA = createNewestWins()
	const clientB = createNewestWins()

	// crud merge replaces the row by key, so each frame arrives as the whole
	// current row rather than as a delta - which is exactly why arrival order
	// decides the display without this gate.
	clientA([one])
	const a = clientA([two])

	clientB([two])
	const b = clientB([one])

	assert.equal(a[0].value, 2, 'the client that saw them in order must show 2')
	assert.equal(b[0].value, 2, 'the client that saw them reversed must also show 2')
	assert.deepEqual(a, b, 'both clients must display the same row')
})

test('a stale frame cannot lower a value that is already displayed', () => {
	const gate = createNewestWins()
	gate([two])
	const after = gate([one])
	assert.equal(after.length, 1)
	assert.equal(after[0].value, 2)
})

test('a reset wins because it carries a fresher stamp, not because it is a reset', () => {
	const gate = createNewestWins()
	gate([two])
	const after = gate([{ id: 'alpha', value: 0, modifiedAt: 1002 }])
	assert.equal(after[0].value, 0, 'a reset stamped later must be applied even though it lowers the value')

	// And a reset that is genuinely older must NOT be applied, or the rule is
	// "resets always win" rather than "the newest observation wins".
	const stale = gate([{ id: 'alpha', value: 0, modifiedAt: 500 }])
	assert.equal(stale[0].value, 0)
	assert.equal(stale[0].modifiedAt, 1002, 'the older reset must not replace the newer one')
})

test('a same-millisecond tie is broken by the higher count', () => {
	const gate = createNewestWins()
	gate([{ id: 'alpha', value: 5, modifiedAt: 2000 }])
	const after = gate([{ id: 'alpha', value: 4, modifiedAt: 2000 }])
	assert.equal(after[0].value, 5, 'on a counter that only rises, the higher count is the later one')
})

test('records are kept per id and unrelated counters are untouched', () => {
	const gate = createNewestWins()
	gate([{ id: 'alpha', value: 1, modifiedAt: 10 }, { id: 'beta', value: 7, modifiedAt: 10 }])
	const after = gate([{ id: 'alpha', value: 2, modifiedAt: 11 }])
	const byId = Object.fromEntries(after.map((r) => [r.id, r.value]))
	assert.deepEqual(byId, { alpha: 2, beta: 7 })
})
