import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_READING, isReading, reading, rssReading, statReading } from '../../src/lib/ops-readings.js'

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

test('RSS zero means unsampled, because no live process occupies 0 MB', () => {
	// The adapter initialises its pressure snapshot with memoryMB: 0 and
	// stamps the real value on the first ~1Hz sampler tick, so a page
	// opened inside that window reads a placeholder. This is the only
	// oracle for that rule: a warm e2e server has always sampled by the
	// time the browser looks, so the pre-sample window is unreachable
	// there and a regression would pass the browser tests unnoticed.
	assert.equal(rssReading(0), NO_READING)
	assert.equal(rssReading(undefined), NO_READING)
	assert.equal(rssReading(137.6), '138')
	assert.equal(rssReading(0.4), '0')
})
