import assert from 'node:assert/strict'
import test from 'node:test'
import { fieldPerformanceEnabled, parseFieldPerformanceSample, recordFieldPerformanceSample, readFieldPerformanceDay } from '../../src/lib/server/field-performance.js'
import { summarizeFieldPerformance } from '../../scripts/field-performance.mjs'

function sample() {
	return {
		schemaVersion: 1,
		device: 'mobile', connection: '4g',
		metrics: {
			lcp: { eligible: true, value: 1200 },
			inp: { eligible: false, value: null },
			cls: { eligible: true, value: 0.04 }
		}
	}
}

function redisWithTransaction() {
	const commands = []
	const transaction = {
		hincrby(...args) { commands.push(['hincrby', ...args]); return transaction },
		hset(...args) { commands.push(['hset', ...args]); return transaction },
		expire(...args) { commands.push(['expire', ...args]); return transaction },
		async exec() { commands.push(['exec']); return [] }
	}
	return { commands, multi: () => transaction }
}

test('a navigation stores only aggregate counters, histograms and expiry', async () => {
	const redis = redisWithTransaction()
	await recordFieldPerformanceSample(redis, sample(), new Date('2026-10-28T12:00:00Z'))
	const key = 'field-performance:2026-10-28:mobile:4g:unknown'
	assert.deepEqual(redis.commands, [
		['hincrby', key, 'navigationCount', 1],
		['hset', key, 'collectorVersion', '1.0.0'],
		['hincrby', key, 'lcp.eligibleCount', 1],
		['hincrby', key, 'lcp.value:1200', 1],
		['hincrby', key, 'cls.eligibleCount', 1],
		['hincrby', key, 'cls.value:0.04', 1],
		['expire', key, 2764800],
		['exec']
	])
	assert.equal(JSON.stringify(redis.commands).includes('identity'), false)
})

test('samples reject private additions, invalid dimensions and inconsistent eligibility', () => {
	for (const mutate of [
		value => { value.identity = 'visitor-id' },
		value => { value.device = 'phone' },
		value => { value.metrics.lcp.value = -1 },
		value => { value.metrics.inp.value = 20 },
		value => { delete value.metrics.cls }
	]) {
		const value = sample()
		mutate(value)
		assert.throws(() => parseFieldPerformanceSample(value))
	}
})

test('daily exports aggregate sorted distributions and preserve missing coverage', async () => {
	const key = 'field-performance:2026-10-28:mobile:4g:unknown'
	const values = { navigationCount: '2', collectorVersion: '1.0.0' }
	for (const name of ['lcp', 'inp', 'cls']) {
		values[`${name}.eligibleCount`] = '2'
		values[`${name}.missingCount`] = '1'
	}
	values['lcp.value:1400'] = '1'
	values['inp.value:80'] = '1'
	values['cls.value:0.02'] = '1'
	const redis = {
		async scan(cursor) { return cursor === '0' ? ['7', [key]] : ['0', []] },
		async hgetall(requested) { assert.equal(requested, key); return values }
	}
	const output = await readFieldPerformanceDay(redis, '2026-10-28')
	assert.equal(output.segments.length, 1)
	assert.deepEqual(output.window, { start: '2026-10-28', end: '2026-10-29' })
	assert.deepEqual(output.coverage.geography, ['unknown'])
	const summary = summarizeFieldPerformance(output)
	const mobile = summary.segments.find(segment => segment.device === 'mobile' && segment.connection === '4g' && segment.geography === 'unknown')
	assert.equal(mobile.navigationCount, 2)
	assert.equal(mobile.metrics.lcp.sampleCount, 1)
	assert.equal(mobile.metrics.lcp.p75, null)
	assert.equal(mobile.metrics.lcp.reason, 'insufficient-samples')
	assert.equal(summary.segments.filter(segment => segment.navigationCount === null).length, 19)
})

test('daily reads reject invalid dates and corrupt stored counters', async () => {
	const redis = {
		async scan() { return ['0', ['field-performance:2026-10-28:desktop:unknown:unknown']] },
		async hgetall() { return { navigationCount: 'not-a-count' } }
	}
	await assert.rejects(readFieldPerformanceDay(redis, '2026-02-30'))
	await assert.rejects(readFieldPerformanceDay(redis, '2026-10-28'))
})

test('the collection flag is read from the runtime environment on every call', (t) => {
	const previous = process.env.FIELD_PERFORMANCE_COLLECTION
	t.after(() => {
		if (previous === undefined) delete process.env.FIELD_PERFORMANCE_COLLECTION
		else process.env.FIELD_PERFORMANCE_COLLECTION = previous
	})
	delete process.env.FIELD_PERFORMANCE_COLLECTION
	assert.equal(fieldPerformanceEnabled(), false)
	process.env.FIELD_PERFORMANCE_COLLECTION = '1'
	assert.equal(fieldPerformanceEnabled(), true)
	process.env.FIELD_PERFORMANCE_COLLECTION = 'true'
	assert.equal(fieldPerformanceEnabled(), false)
})
