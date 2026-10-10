import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeControl } from '../../src/lib/versioned-control.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
function harness() {
	let notify
	let stopped = false
	const pending = []
	const seen = []
	const stream = { subscribe(fn) { notify = fn; fn(undefined); return () => { stopped = true } } }
	const stop = subscribeControl(stream, () => new Promise((resolve, reject) => pending.push({ resolve, reject })), (value) => seen.push(value))
	return { notify: (value) => notify(value), pending, seen, stop, get stopped() { return stopped } }
}

test('a snapshot recovers the newer write hidden by set-merge frame batching', async () => {
	const h = harness()
	assert.equal(h.pending.length, 0)
	// The stream exposes only the last (older) payload from one browser frame.
	h.notify({ speed: 10, revision: '1' })
	h.pending[0].resolve({ speed: 20, revision: '2' })
	await tick()
	assert.deepEqual(h.seen.at(-1), { speed: 20, revision: '2' })
	h.stop()
})

test('changes during a read force one trailing read and never overlap RPCs', async () => {
	const h = harness()
	h.notify({ speed: 10, revision: '1' })
	h.notify({ speed: 20, revision: '2' })
	h.notify({ speed: 30, revision: '3' })
	assert.equal(h.pending.length, 1)
	h.pending[0].resolve({ speed: 10, revision: '1' })
	await tick()
	assert.equal(h.seen.at(-1).speed, 30)
	assert.equal(h.pending.length, 2)
	h.pending[1].resolve({ speed: 40, revision: '4' })
	await tick()
	assert.equal(h.seen.at(-1).speed, 40)
	assert.equal(h.pending.length, 2)
	h.stop()
})

test('revision comparison remains exact above the JavaScript integer limit', async () => {
	const h = harness()
	h.notify({ bias: 'hot', revision: '9007199254740993' })
	h.notify({ bias: 'uniform', revision: '9007199254740992' })
	h.pending[0].resolve({ bias: 'uniform', revision: '9007199254740992' })
	await tick()
	assert.deepEqual(h.seen, [{ bias: 'hot', revision: '9007199254740993' }])
	h.stop()
	h.pending[1].resolve({ bias: 'monopoly', revision: '9007199254740994' })
	await tick()
	assert.equal(h.seen.length, 1)
	assert.equal(h.stopped, true)
})

test('teardown drops an in-flight reply and cancels a dirty trailing read', async () => {
	const h = harness()
	h.notify({ speed: 10, revision: '1' })
	h.notify({ speed: 20, revision: '2' })
	h.stop()
	h.pending[0].resolve({ speed: 30, revision: '3' })
	await tick()
	assert.equal(h.seen.at(-1).speed, 20)
	assert.equal(h.pending.length, 1)
	assert.equal(h.stopped, true)
})

test('a rejected read retries on the next notification', async () => {
	const h = harness()
	h.notify({ speed: 10, revision: '1' })
	h.pending[0].reject(new Error('disconnected'))
	await tick()
	h.notify({ speed: 20, revision: '2' })
	h.pending[1].resolve({ speed: 30, revision: '3' })
	await tick()
	assert.equal(h.seen.at(-1).speed, 30)
	h.stop()
})

test('a read rejected while dirty still performs the trailing read', async () => {
	const h = harness()
	h.notify({ speed: 10, revision: '1' })
	h.notify({ speed: 20, revision: '2' })
	h.pending[0].reject(new Error('temporarily unavailable'))
	await tick()
	assert.equal(h.pending.length, 2)
	h.pending[1].resolve({ speed: 30, revision: '3' })
	await tick()
	assert.equal(h.seen.at(-1).speed, 30)
	h.stop()
})

test('an authoritative default snapshot rebases a reset revision without another write', async () => {
	const h = harness()
	h.notify({ speed: 40, revision: '40' })
	h.pending[0].resolve({ speed: 40, revision: '40' })
	await tick()
	h.notify({ speed: 10, revision: '0' })
	h.pending[1].resolve({ speed: 10, revision: '0' })
	await tick()
	assert.deepEqual(h.seen.at(-1), { speed: 10, revision: '0' })
	h.notify({ speed: 12, revision: '1' })
	assert.deepEqual(h.seen.at(-1), { speed: 12, revision: '1' })
	h.stop()
	h.pending[2].resolve({ speed: 12, revision: '1' })
	await tick()
})

test('a reset followed by a lower revision write converges through the snapshot', async () => {
	const h = harness()
	h.notify({ speed: 40, revision: '40' })
	h.pending[0].resolve({ speed: 40, revision: '40' })
	await tick()
	h.notify({ speed: 10, revision: '0' })
	h.pending[1].resolve({ speed: 15, revision: '1' })
	await tick()
	assert.deepEqual(h.seen.at(-1), { speed: 15, revision: '1' })
	h.stop()
})

test('a delayed high revision from before a reset cannot prevent authoritative convergence', async () => {
	const h = harness()
	h.notify({ speed: 10, revision: '0' })
	h.pending[0].resolve({ speed: 12, revision: '1' })
	await tick()
	h.notify({ speed: 40, revision: '40' })
	h.pending[1].resolve({ speed: 12, revision: '1' })
	await tick()
	assert.deepEqual(h.seen.at(-1), { speed: 12, revision: '1' })
	h.notify({ speed: 14, revision: '2' })
	assert.deepEqual(h.seen.at(-1), { speed: 14, revision: '2' })
	h.stop()
	h.pending[2].resolve({ speed: 14, revision: '2' })
	await tick()
})

test('invalid authoritative revisions cannot rebase valid state', async () => {
	for (const revision of [undefined, null, 0, '-1', '1.5', 'invalid']) {
		const h = harness()
		h.notify({ speed: 40, revision: '40' })
		h.pending[0].resolve({ speed: 10, revision })
		await tick()
		assert.deepEqual(h.seen, [{ speed: 40, revision: '40' }])
		h.notify({ speed: 20, revision: '20' })
		assert.equal(h.seen.length, 1)
		h.stop()
		h.pending[1].resolve({ speed: 20, revision: '20' })
		await tick()
	}
})

test('a reset notification during an old read discards the old reply before rebasing', async () => {
	const h = harness()
	h.notify({ speed: 40, revision: '40' })
	h.notify({ speed: 10, revision: '0' })
	h.pending[0].resolve({ speed: 41, revision: '41' })
	await tick()
	assert.deepEqual(h.seen, [{ speed: 40, revision: '40' }])
	assert.equal(h.pending.length, 2)
	h.pending[1].resolve({ speed: 10, revision: '0' })
	await tick()
	assert.deepEqual(h.seen.at(-1), { speed: 10, revision: '0' })
	h.stop()
})
