import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseAst } from 'vite'
import { combineCounts, configureForget, live, realtime } from 'svelte-realtime/server'
import * as realtimeServer from 'svelte-realtime/server'
import { createTestEnv } from 'svelte-realtime/testing'
import { TOPICS } from '../../src/lib/server/topics.js'

// Test-only teardown is exported by the runtime, outside the public typings.
const { _resetAggregates } = /** @type {any} */ (realtimeServer)

// Evaluate the actual declarations without starting the modules' Redis clients
// or cron jobs. Reducers, windows and erasure options run in the real engine.
function declaration(file, name) {
	const source = readFileSync(new URL(`../../src/live/demos/${file}.js`, import.meta.url), 'utf8')
	const ast = /** @type {any} */ (parseAst(source))
	const expression = ast.body.find((node) => node.type === 'ExportNamedDeclaration'
		&& node.declaration?.declarations?.[0]?.id.name === name).declaration.declarations[0].init
	const helper = ast.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'moodReducers')
	const helperSource = helper ? source.slice(helper.start, helper.end) : ''
	return new Function('live', 'TOPICS', 'combineCounts', 'K',
		`${helperSource}; return ${source.slice(expression.start, expression.end)}`)(live, TOPICS, combineCounts, 3)
}

for (const name of ['rawMood', 'privateMood']) {
	test(`${name} erasure resets submitted mood totals and the next cohort`, async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12, 0, 10) })
		realtime({ privacySecret: 'aggregate-erasure-test-secret' })
		const env = createTestEnv()
		t.after(() => { _resetAggregates(); configureForget(null); env.cleanup() })
		const aggregate = declaration('privacy', name)
		env.register('privacy', { [name]: aggregate })
		configureForget({ platform: env.platform })
		for (const userId of ['visitor', 'companion-a', 'companion-b']) {
			env.platform.publish(TOPICS.demoPrivacyMoods, 'submitted', { userId, score: 4 })
		}
		const populated = await aggregate.__windowStreams.round()
		assert.equal(typeof populated.n, 'number')
		assert.notDeepEqual(populated, { sum: 0, n: 0, avg: 0 })
		const result = await live.forget('visitor')
		assert.equal(result.ok, true)
		assert.deepEqual(await aggregate.__windowStreams.round(), { sum: 0, n: 0, avg: 0 })
		env.platform.publish(TOPICS.demoPrivacyMoods, 'submitted', { userId: 'new-visitor', score: 2 })
		// The protected aggregate holds its clean value until a fresh cohort
		// reaches k; the raw aggregate starts counting from zero immediately.
		assert.deepEqual(await aggregate.__windowStreams.round(), name === 'privateMood'
			? { sum: 0, n: 0, avg: 0 } : { sum: 2, n: 1, avg: 2 })
	})
}

for (const [file, topic, field] of [
	['topk', TOPICS.demoTopkEvent, 'itemId'],
	['news', TOPICS.demoNewsView, 'storyId']
]) {
	test(`${file} erasure retains synthetic view totals in every window`, async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12, 0, 10) })
		const env = createTestEnv()
		t.after(() => { _resetAggregates(); configureForget(null); env.cleanup() })
		const aggregate = declaration(file, 'trending')
		env.register(file, { trending: aggregate })
		configureForget({ platform: env.platform })
		env.platform.publish(topic, 'viewed', { [field]: 'aurora' })
		env.platform.publish(topic, 'viewed', { [field]: 'aurora' })
		const before = await Promise.all(Object.values(aggregate.__windowStreams).map((load) => load()))
		for (const snapshot of before) assert.equal(snapshot.counts.aurora, 2)
		const result = await live.forget('visitor')
		assert.equal(result.ok, true)
		const after = await Promise.all(Object.values(aggregate.__windowStreams).map((load) => load()))
		assert.deepEqual(after, before)
	})
}
