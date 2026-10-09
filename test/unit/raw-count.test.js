import assert from 'node:assert/strict'
import test from 'node:test'
import { CLOSE_GRACE_MS, rawBaseline, rawCounted } from '../e2e/raw-count.js'

// The decision submitMood polls on, taken out of the browser so each branch is
// driven directly: a page that lived through a tumble cannot be staged on
// demand, since a window may close twice around the minute and publish the new,
// empty window over the closing count.

const MINUTE = 29_858_294 * 60_000

test('a count that arrived before the minute began is not the baseline', () => {
	// The closing window's count, still on the card after the tumble. The new
	// window's first publish carries n = 1, which must count.
	const { before, fromEarlierWindow } = rawBaseline({ shown: 2, arrivedAt: MINUTE - 20_000, windowStart: MINUTE })
	assert.equal(before, 0)
	assert.equal(fromEarlierWindow, true)
	assert.equal(rawCounted({ before, delivered: 1, shown: 1 }), true)
})

test('a count that arrived inside the grace is taken as an earlier window\'s', () => {
	// A closing publish can land about a second into the next minute, and a
	// second close about a second after that: two seconds, no more.
	assert.equal(rawBaseline({ shown: 3, arrivedAt: MINUTE + 1_000, windowStart: MINUTE }).before, 0)
	assert.equal(rawBaseline({ shown: 3, arrivedAt: MINUTE + 1_999, windowStart: MINUTE }).before, 0)
	assert.equal(rawBaseline({ shown: 3, arrivedAt: MINUTE + 2_000, windowStart: MINUTE }).before, 3)
	assert.deepEqual(rawBaseline({ shown: 3, arrivedAt: MINUTE + CLOSE_GRACE_MS - 1, windowStart: MINUTE }), { before: 0, fromEarlierWindow: true })
	assert.deepEqual(rawBaseline({ shown: 3, arrivedAt: MINUTE + CLOSE_GRACE_MS, windowStart: MINUTE }), { before: 3, fromEarlierWindow: false })
})

test('a count that arrived well into the minute is the baseline', () => {
	const { before } = rawBaseline({ shown: 4, arrivedAt: MINUTE + 30_000, windowStart: MINUTE })
	assert.equal(before, 4)
	assert.equal(rawCounted({ before, delivered: 4, shown: 4 }), false, 'a publish that did not raise the count is not this submission')
	assert.equal(rawCounted({ before, delivered: 5, shown: 5 }), true)
})

test('a count the record cannot date is not the baseline', () => {
	assert.deepEqual(rawBaseline({ shown: 2, arrivedAt: null, windowStart: MINUTE }), { before: 0, fromEarlierWindow: true })
})

test('a card already above the baseline does not count without a frame since the mark', () => {
	assert.equal(rawCounted({ before: 0, delivered: undefined, shown: 2 }), false)
})

test('a frame since the mark does not count until the card shows it', () => {
	// The page received the publish and kept showing something else.
	assert.equal(rawCounted({ before: 0, delivered: 1, shown: 2 }), false)
	assert.equal(rawCounted({ before: 2, delivered: 3, shown: 2 }), false)
})
