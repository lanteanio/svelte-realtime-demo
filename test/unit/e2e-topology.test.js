import assert from 'node:assert/strict'
import test from 'node:test'
import { startProjectReplicas } from '../../scripts/e2e-topology.mjs'

async function start(project, count) {
	const started = []
	let nextPort = 4301
	const targets = await startProjectReplicas(project, count, {
		freePort: async () => nextPort++,
		startApp: async (port) => { started.push(port) }
	})
	return { started, targets }
}

test('cluster and diagnostics start each configured replica and expose its own origin', async () => {
	for (const project of ['cluster', 'diagnostics']) {
		for (const count of [2, 4]) {
			const { started, targets } = await start(project, count)
			assert.deepEqual(started, count === 2 ? [4301, 4302] : [4301, 4302, 4303, 4304], project)
			assert.deepEqual(targets, {
				BASE_URL: 'http://127.0.0.1:4301',
				INSTANCE_B: 'http://127.0.0.1:4302',
				INSTANCE_C: count === 4 ? 'http://127.0.0.1:4303' : '',
				INSTANCE_D: count === 4 ? 'http://127.0.0.1:4304' : ''
			}, project)
		}
	}
})

test('single-instance tiers start only one app and clear every inherited replica target', async () => {
	for (const project of ['main', 'isolated', 'resilience', 'stress', 'destroyer']) {
		const { started, targets } = await start(project, 4)
		assert.deepEqual(started, [4301], project)
		assert.deepEqual({ INSTANCE_B: 'stale-b', INSTANCE_C: 'stale-c', INSTANCE_D: 'stale-d', ...targets }, {
			BASE_URL: 'http://127.0.0.1:4301', INSTANCE_B: '', INSTANCE_C: '', INSTANCE_D: ''
		}, project)
	}
})

test('a replica startup failure is propagated before any later replica starts', async () => {
	const started = []
	const failure = new Error('app failed to start')
	let nextPort = 4301
	await assert.rejects(startProjectReplicas('diagnostics', 4, {
		freePort: async () => nextPort++,
		startApp: async (port) => {
			started.push(port)
			if (port === 4302) throw failure
		}
	}), (error) => error === failure)
	assert.deepEqual(started, [4301, 4302])
})
