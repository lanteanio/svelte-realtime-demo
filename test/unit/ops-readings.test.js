import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	NO_READING,
	SAMPLE_STALE_MS,
	ageReading,
	isReading,
	pressureState,
	reading,
	statReading
} from '../../src/lib/ops-readings.js'

test('a measured zero survives; an absent field does not become one', () => {
	assert.equal(reading(0), '0')
	assert.equal(reading(42), '42')
	assert.equal(reading(undefined), NO_READING)
	assert.equal(reading(null), NO_READING)
	// The bug this whole module exists to prevent: `?? 0` reporting a
	// field the server never sent as a measurement of zero.
	assert.notEqual(reading(undefined), '0')
})

test('non-finite values are not readings', () => {
	assert.equal(isReading(Number.NaN), false)
	assert.equal(isReading(Number.POSITIVE_INFINITY), false)
	assert.equal(reading(Number.NaN), NO_READING)
	assert.equal(statReading(Number.NaN, 1), NO_READING)
})

test('statistics keep their requested precision, absent ones stay blank', () => {
	assert.equal(statReading(0.4), '0')
	assert.equal(statReading(12.34, 1), '12.3')
	assert.equal(statReading(0, 1), '0.0')
	assert.equal(statReading(undefined, 1), NO_READING)
})

// These are the only oracle for the pre-sample window: a warm e2e server
// has always sampled by the time the browser looks, so the state cannot be
// reached from a browser test and a regression there would report green.

test('a snapshot the sampler has not folded is unsampled in every field, not just the impossible one', () => {
	// Exactly the object the adapter holds between process start and the
	// first fold. The old rule read memoryMB and called the rest readings,
	// which is why this is the shape the assertion is written against: the
	// zeros below are indistinguishable from an idle worker's real numbers,
	// and sampledAt is the only thing in here that knows.
	const placeholders = {
		sampledAt: null,
		active: false,
		reason: 'NONE',
		value: 0,
		subscriberRatio: 0,
		publishRate: 0,
		memoryMB: 0,
		maxBufferedBytes: 0,
		backpressuredConnections: 0
	}
	assert.equal(pressureState(placeholders, null), 'unsampled')
	// Same zeros, one fold later: now every one of them is a measurement.
	assert.equal(pressureState({ ...placeholders, sampledAt: 1_760_000_000_000, memoryMB: 138 }, 120), 'live')
})

test('an undated snapshot cannot vouch for its numbers either', () => {
	// An adapter too old to stamp its samples omits the field rather than
	// nulling it. Both are "nobody measured this".
	assert.equal(pressureState({ memoryMB: 138, publishRate: 4 }, null), 'unsampled')
	assert.equal(pressureState({ sampledAt: Number.NaN, memoryMB: 138 }, null), 'unsampled')
})

test('no snapshot at all is its own state, distinct from an unsampled one', () => {
	assert.equal(pressureState(null, null), 'missing')
	assert.equal(pressureState(undefined, null), 'missing')
})

test('readings older than the sampler period are stale, and the boundary belongs to live', () => {
	const sampled = { sampledAt: 1_760_000_000_000, memoryMB: 138 }
	assert.equal(pressureState(sampled, 0), 'live')
	assert.equal(pressureState(sampled, SAMPLE_STALE_MS - 1), 'live')
	// The threshold itself is still a reading: a sampler is wedged once it
	// has missed the window, not the instant it reaches the edge of it.
	assert.equal(pressureState(sampled, SAMPLE_STALE_MS), 'live')
	assert.equal(pressureState(sampled, SAMPLE_STALE_MS + 1), 'stale')
	assert.equal(pressureState(sampled, 60_000), 'stale')
})

test('a dated sample with no age stays live rather than inventing a fault', () => {
	// The age is computed server-side and may simply not be present (an
	// older RPC shape, a snapshot assembled elsewhere). Absent evidence of
	// staleness is not evidence of it.
	const sampled = { sampledAt: 1_760_000_000_000, memoryMB: 138 }
	assert.equal(pressureState(sampled, null), 'live')
	assert.equal(pressureState(sampled, undefined), 'live')
})

test('the freshness caption reports a negative age instead of hiding it', () => {
	assert.equal(ageReading(0), '0.0')
	assert.equal(ageReading(340), '0.3')
	assert.equal(ageReading(12_400), '12.4')
	assert.equal(ageReading(null), NO_READING)
	// Only reachable if the stamp and the clock that aged it came from
	// different processes. Clamping it to 0.0 would render that as a
	// perfectly fresh sample.
	assert.equal(ageReading(-400), '-0.4')
})
