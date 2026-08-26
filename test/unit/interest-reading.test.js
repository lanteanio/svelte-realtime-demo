import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interestReading } from '../../src/lib/interest-reading.js'

test('a stale denominator never renders a fraction above one', () => {
	// The live interest set has taken in entities the population poll has not
	// reported yet: 150 remote entities against a world last polled at 149
	// including self, which would print "receiving 150 of 148".
	const r = interestReading(150, 149)
	assert.equal(r.receiving, 150)
	assert.ok(r.total >= r.receiving, `denominator ${r.total} must not sit below the ${r.receiving} entities being received`)
	assert.equal(r.total, 150)
	assert.equal(r.culled, 0)
})

test('the culled percentage stays inside its own range whatever the poll says', () => {
	for (const [receiving, population] of [[150, 149], [150, 1], [3, 0], [17, 151]]) {
		const { culled } = interestReading(receiving, population)
		assert.ok(culled >= 0 && culled <= 100, `culled ${culled}% is outside 0..100 for ${receiving}/${population}`)
	}
})

test('an agreeing pair is reported exactly as measured', () => {
	// The ordinary case, and the one the reconciliation must not disturb: a
	// poll that has caught up reports the real cull rather than a floor.
	const r = interestReading(17, 151)
	assert.deepEqual(r, { receiving: 17, total: 150, culled: 89 })
})

test('an empty world reports no cull instead of dividing by zero', () => {
	assert.deepEqual(interestReading(0, 1), { receiving: 0, total: 0, culled: 0 })
	assert.deepEqual(interestReading(0, 0), { receiving: 0, total: 0, culled: 0 })
})

test('a poll that has not answered yet cannot invent a denominator', () => {
	// `total` starts at 0 and stays there until the first poll returns, which
	// is also what a failed poll leaves behind.
	assert.deepEqual(interestReading(0, undefined), { receiving: 0, total: 0, culled: 0 })
	assert.deepEqual(interestReading(4, Number.NaN), { receiving: 4, total: 4, culled: 0 })
})
