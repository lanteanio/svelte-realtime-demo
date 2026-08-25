import assert from 'node:assert/strict'
import test from 'node:test'
import { partitionFired, RETENTION_MS } from '../../src/lib/server/alarm-retention.js'

// The failure this exists for: the fired log was bounded by count alone, so
// with light traffic a record from days ago sat in "Fired alarms"
// indefinitely. The partition is the age half of retention, and the boundary
// is the part a green suite cannot vouch for by accident - so it is pinned
// from both sides of the exact edge.

const NOW = 1_700_000_000_000

function record(id, firedAgoMs) {
	const entry = { id, firedAt: NOW - firedAgoMs }
	return { entry, raw: JSON.stringify(entry) }
}

test('a record younger than the window survives, including one about to age out', () => {
	const nearlyStale = record('edge', RETENTION_MS - 1)
	const { fresh, stale } = partitionFired([record('young', 1_000), nearlyStale], NOW)
	assert.equal(stale.length, 0)
	assert.deepEqual(fresh.map((r) => r.entry.id), ['young', 'edge'])
})

test('a record exactly RETENTION_MS old is stale: the window is strictly less than a day', () => {
	const { fresh, stale } = partitionFired([record('exact', RETENTION_MS)], NOW)
	assert.equal(fresh.length, 0)
	assert.deepEqual(stale.map((r) => r.entry.id), ['exact'])
})

test('records past the window go stale and keep their newest-first order', () => {
	const rows = [record('a', 1_000), record('b', RETENTION_MS + 5_000), record('c', RETENTION_MS + 60_000)]
	const { fresh, stale } = partitionFired(rows, NOW)
	assert.deepEqual(fresh.map((r) => r.entry.id), ['a'])
	assert.deepEqual(stale.map((r) => r.entry.id), ['b', 'c'])
})

test('a record with no readable firedAt is stale, not immortal', () => {
	const missing = { entry: { id: 'no-stamp' }, raw: '{"id":"no-stamp"}' }
	const wrongType = { entry: { id: 'text-stamp', firedAt: 'yesterday' }, raw: '{"id":"text-stamp","firedAt":"yesterday"}' }
	const nan = { entry: { id: 'nan-stamp', firedAt: Number.NaN }, raw: '{"id":"nan-stamp","firedAt":null}' }
	const { fresh, stale } = partitionFired([missing, wrongType, nan, record('ok', 10)], NOW)
	assert.deepEqual(fresh.map((r) => r.entry.id), ['ok'])
	assert.deepEqual(stale.map((r) => r.entry.id), ['no-stamp', 'text-stamp', 'nan-stamp'])
})

test('an empty log partitions to two empty halves', () => {
	const { fresh, stale } = partitionFired([], NOW)
	assert.equal(fresh.length, 0)
	assert.equal(stale.length, 0)
})
