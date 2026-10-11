import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { bindMaintenanceInput, failureWindows, maintenanceOrigin, startMaintenanceMonitor } from '../../scripts/maintenance-monitor.mjs'

async function waitFor(condition) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return
		await delay(5)
	}
	throw new Error('Observation deadline exceeded')
}

test('failed probes and a failed smoke keep sampling until smoke and readiness recover', async () => {
	const written = []
	let calls = 0
	let smokePasses = false
	const monitor = startMaintenanceMonitor({
		origin: 'https://example.test', intervalMs: 2,
		persist: record => { written.push(record) },
		probe: async () => {
			calls++
			if (calls === 2) return 503
			if (calls === 3) throw new DOMException('timeout', 'TimeoutError')
			return 200
		},
		smoke: async () => smokePasses
	})
	try {
		await waitFor(() => calls >= 4)
		assert.equal(await monitor.complete(), false)
		const countAfterFailure = calls
		await waitFor(() => calls > countAfterFailure + 1)
		smokePasses = true
		assert.equal(await monitor.complete(), true)
		const result = await monitor.done
		assert.equal(result.outcome, 'complete')
		assert.equal(result.samples[1].status, 503)
		assert.equal(result.samples[2].error, 'TimeoutError')
		assert.deepEqual(result.smokeAttempts.map(attempt => attempt.passed), [false, true])
		assert.equal(result.samples.at(-1).status, 200)
		assert.equal(written.at(-1).outcome, 'complete')
		assert.ok(written.some(record => record.samples.length === 3 && record.outcome === 'monitoring'))
	} finally { await monitor.stop() }
})

test('a successful smoke cannot finish while readiness fails', async () => {
	let status = 503
	const monitor = startMaintenanceMonitor({ origin: 'https://example.test', intervalMs: 2, persist: () => {}, probe: async () => status, smoke: async () => true })
	try {
		assert.equal(await monitor.complete(), false)
		status = 200
		assert.equal(await monitor.complete(), true)
		assert.equal((await monitor.done).outcome, 'complete')
	} finally { await monitor.stop() }
})

test('sampling and persistence continue while external smoke is pending', async () => {
	const { promise: smokeResult, resolve: releaseSmoke } = Promise.withResolvers()
	const written = []
	const monitor = startMaintenanceMonitor({ origin: 'https://example.test', intervalMs: 2, persist: record => { written.push(record) }, probe: async () => 200, smoke: () => smokeResult })
	try {
		await waitFor(() => written.at(-1)?.samples.length >= 2)
		const completing = monitor.complete()
		const before = written.at(-1).samples.length
		await waitFor(() => written.at(-1).samples.length >= before + 3)
		assert.equal(written.at(-1).outcome, 'monitoring')
		releaseSmoke(true)
		assert.equal(await completing, true)
		assert.equal((await monitor.done).outcome, 'complete')
	} finally { releaseSmoke(false); await monitor.stop() }
})

test('successful final readiness atomically stops a queued failing background probe', async () => {
	const { promise: initial, resolve: releaseInitial } = Promise.withResolvers()
	const { promise: final, resolve: releaseFinal } = Promise.withResolvers()
	let calls = 0
	let smokeEntered = false
	const monitor = startMaintenanceMonitor({
		origin: 'https://example.test', intervalMs: 1, persist: () => {},
		probe: async () => { calls++; return calls === 1 ? initial : calls === 2 ? final : 503 },
		smoke: async () => { smokeEntered = true; return true }
	})
	try {
		await waitFor(() => calls === 1)
		const completing = monitor.complete()
		await waitFor(() => smokeEntered)
		await delay(5)
		releaseInitial(200)
		await waitFor(() => calls === 2)
		await delay(10)
		releaseFinal(200)
		assert.equal(await completing, true)
		const result = await monitor.done
		assert.equal(calls, 2)
		assert.equal(result.samples.length, 2)
		assert.equal(result.samples.at(-1).status, 200)
		assert.equal(result.outcome, 'complete')
	} finally { releaseInitial(200); releaseFinal(200); await monitor.stop() }
})

test('abort preserves an unrecovered observation window without inventing its duration', async () => {
	let count = 0
	const monitor = startMaintenanceMonitor({ origin: 'https://example.test', intervalMs: 2, persist: () => {}, probe: async () => { count++; return 503 }, smoke: async () => true })
	await waitFor(() => count >= 2)
	const result = await monitor.stop()
	assert.equal(result.outcome, 'aborted')
	assert.equal(result.failureWindows.length, 1)
	assert.equal(result.failureWindows[0].previousSuccessfulProbe, null)
	assert.equal(result.failureWindows[0].firstRecoveredProbe, null)
	assert.equal(result.failureWindows[0].probeStartSpanMs, null)
})

test('separate recovered failures stay separate and timestamps retain probe uncertainty', () => {
	const samples = [200, 503, 200, 503].map((status, i) => ({ status, error: null, startedAt: new Date(i * 1000).toISOString(), finishedAt: new Date(i * 1000 + 100).toISOString() }))
	const windows = failureWindows(samples)
	assert.equal(windows.length, 2)
	assert.equal(windows[0].previousSuccessfulProbe.finishedAt, samples[0].finishedAt)
	assert.equal(windows[0].firstFailedProbe.finishedAt, samples[1].finishedAt)
	assert.equal(windows[0].firstRecoveredProbe.startedAt, samples[2].startedAt)
	assert.equal(windows[0].probeStartSpanMs, 1000)
	assert.equal(windows[1].probeStartSpanMs, null)
})

test('remote cleartext targets and credential-bearing URLs are refused', () => {
	for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/board', 'https://example.test/?token=value']) assert.throws(() => maintenanceOrigin(url))
	assert.equal(maintenanceOrigin('https://example.test'), 'https://example.test')
	assert.equal(maintenanceOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
})

test('terminal Ctrl+C aborts and records a non-success outcome', async () => {
	const stream = new PassThrough()
	const input = createInterface({ input: stream, output: new PassThrough(), terminal: true })
	const written = []
	const monitor = startMaintenanceMonitor({ origin: 'https://example.test', intervalMs: 2, persist: record => { written.push(record) }, probe: async () => 503, smoke: async () => true })
	bindMaintenanceInput(input, monitor, () => {})
	try {
		await waitFor(() => written.at(-1)?.samples.length >= 1)
		stream.write('\x03')
		await waitFor(() => written.at(-1)?.finishedAt !== null)
		assert.equal((await monitor.done).outcome, 'aborted')
		assert.equal(written.at(-1).outcome, 'aborted')
	} finally { input.close(); stream.destroy(); await monitor.stop() }
})

test('probe errors open and extend failure windows even with a success status', () => {
	const samples = [
		{ status: 200, error: null },
		{ status: null, error: 'TimeoutError' },
		{ status: 200, error: 'Error' },
		{ status: 200, error: null }
	].map((sample, i) => ({ ...sample, startedAt: new Date(i * 1000).toISOString(), finishedAt: new Date(i * 1000 + 100).toISOString() }))
	const windows = failureWindows(samples)
	assert.equal(windows.length, 1)
	assert.equal(windows[0].firstFailedProbe.startedAt, samples[1].startedAt)
	assert.equal(windows[0].lastFailedProbe.startedAt, samples[2].startedAt)
	assert.equal(windows[0].firstRecoveredProbe.startedAt, samples[3].startedAt)
	assert.equal(windows[0].probeStartSpanMs, 2000)
})

test('a later stop cannot replace successful completion', async () => {
	const monitor = startMaintenanceMonitor({ origin: 'https://example.test', intervalMs: 2, persist: () => {}, probe: async () => 200, smoke: async () => true })
	assert.equal(await monitor.complete(), true)
	assert.equal((await monitor.stop('deadline')).outcome, 'complete')
	assert.equal((await monitor.stop('aborted')).outcome, 'complete')
})
