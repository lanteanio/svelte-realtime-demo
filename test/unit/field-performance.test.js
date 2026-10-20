import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { readFieldPerformance, summarizeFieldPerformance } from '../../scripts/field-performance.mjs'

function fixture() {
	const metric = { eligibleCount: 20, missingCount: 0, distribution: [{ value: 10, count: 14 }, { value: 30, count: 1 }, { value: 90, count: 5 }] }
	return {
		schemaVersion: 1, datasetKind: 'test', collectorVersion: '6.1.1',
		window: { start: '2026-10-01', end: '2026-10-08' },
		coverage: { device: ['desktop', 'mobile'], connection: ['4g', 'unknown'], geography: ['europe', 'unknown'] },
		segments: [{ device: 'desktop', connection: '4g', geography: 'europe', navigationCount: 25,
			metrics: { lcp: structuredClone(metric), inp: { eligibleCount: 22, missingCount: 2, distribution: [{ value: 32, count: 15 }, { value: 48, count: 5 }] }, cls: { eligibleCount: 20, missingCount: 0, distribution: [{ value: 0, count: 15 }, { value: 0.125, count: 5 }] } } }]
	}
}

test('field summary uses weighted nearest-rank p75 and keeps metric eligibility separate', () => {
	const row = summarizeFieldPerformance(fixture()).segments[0]
	assert.equal(row.metrics.lcp.p75, 30)
	assert.equal(row.metrics.inp.p75, 32)
	assert.equal(row.metrics.cls.p75, 0)
	assert.deepEqual(row.metrics.inp, { sampleCount: 20, eligibleCount: 22, missingCount: 2, ineligibleCount: 3, p75: 32, reason: null })
	assert.equal(Object.hasOwn(row.metrics.lcp, 'distribution'), false)
})

test('field summary emits every requested segment and preserves missing data as null', () => {
	const result = summarizeFieldPerformance(fixture())
	assert.equal(result.segments.length, 8)
	assert.equal(new Set(result.segments.map(row => `${row.device}/${row.connection}/${row.geography}`)).size, 8)
	for (const row of result.segments.slice(1)) {
		assert.equal(row.navigationCount, null)
		for (const metric of Object.values(row.metrics)) assert.deepEqual(metric, { sampleCount: null, eligibleCount: null, missingCount: null, ineligibleCount: null, p75: null, reason: 'segment-not-collected' })
	}
})

test('field summary suppresses small samples and distinguishes zero observations', () => {
	const input = fixture()
	input.segments[0].metrics.lcp = { eligibleCount: 19, missingCount: 0, distribution: [{ value: 100, count: 19 }] }
	input.segments[0].metrics.inp = { eligibleCount: 0, missingCount: 0, distribution: [] }
	const row = summarizeFieldPerformance(input).segments[0]
	assert.equal(row.metrics.lcp.p75, null)
	assert.equal(row.metrics.lcp.reason, 'insufficient-samples')
	assert.equal(row.metrics.inp.p75, null)
	assert.equal(row.metrics.inp.reason, 'no-samples')
	assert.equal(row.metrics.inp.ineligibleCount, 25)
	assert.equal(summarizeFieldPerformance(fixture(), { minimumSamples: 21 }).segments[0].metrics.cls.p75, null)
	assert.throws(() => summarizeFieldPerformance(input, { minimumSamples: 19 }), /at least 20/)
})

test('field summary rejects unknown fields at every level without accepting identity data', () => {
	for (const select of [value => value, value => value.window, value => value.coverage, value => value.segments[0], value => value.segments[0].metrics, value => value.segments[0].metrics.lcp, value => value.segments[0].metrics.lcp.distribution[0]]) {
		const input = fixture()
		select(input).visitorId = 'private-value'
		assert.throws(() => summarizeFieldPerformance(input), /unexpected or missing fields/)
	}
})

test('field summary rejects ambiguous counts and malformed distributions', () => {
	for (const mutate of [
		value => { value.segments[0].navigationCount = -1 },
		value => { value.segments[0].metrics.lcp.eligibleCount = 26; value.segments[0].metrics.lcp.missingCount = 6 },
		value => { value.segments[0].metrics.lcp.missingCount = 1 },
		value => { value.segments[0].metrics.lcp.distribution[0].count = 0; value.segments[0].metrics.lcp.distribution[1].count = 15 },
		value => { value.segments[0].metrics.lcp.distribution[0].count = 14.5; value.segments[0].metrics.lcp.distribution[1].count = 0.5 },
		value => { value.segments[0].metrics.lcp.distribution[0].count = Number.MAX_SAFE_INTEGER + 1 },
		value => { value.segments[0].metrics.lcp.distribution[0].value = NaN },
		value => { value.segments[0].metrics.lcp.distribution[2].value = Infinity },
		value => { value.segments[0].metrics.lcp.distribution[0].value = -0.5 },
		value => { value.segments[0].metrics.lcp.distribution[0].value = '10' },
		value => { value.segments[0].metrics.lcp.distribution.reverse() },
		value => { value.segments[0].metrics.lcp.distribution[1].value = 10 }
	]) {
		const input = fixture()
		mutate(input)
		assert.throws(() => summarizeFieldPerformance(input))
	}
})

test('field summary rejects invalid windows, schema, dimensions and overlapping segments', () => {
	for (const mutate of [
		value => { value.window.start = '2026-02-30' },
		value => { value.window.end = value.window.start },
		value => { value.window.end = '2026-09-01' },
		value => { value.window.start = '2026-10-01T12:34:56Z' },
		value => { value.schemaVersion = 2 },
		value => { value.datasetKind = 'lab' },
		value => { value.collectorVersion = 'private-user' },
		value => { value.coverage.device = [] },
		value => { value.coverage.device.push('desktop') },
		value => { value.coverage.geography.push('private-city') },
		value => { value.segments[0].device = 'tablet' },
		value => { value.segments.push(structuredClone(value.segments[0])) }
	]) {
		const input = fixture()
		mutate(input)
		assert.throws(() => summarizeFieldPerformance(input))
	}
})

test('field summary preserves test provenance and does not certify field authenticity', () => {
	for (const kind of ['test', 'field']) {
		const input = fixture()
		input.datasetKind = kind
		const result = summarizeFieldPerformance(input)
		assert.equal(result.datasetKind, kind)
		assert.equal(result.sourceAuthenticity, 'unverified')
		assert.deepEqual(result.window, input.window)
		assert.deepEqual(result.units, { lcp: 'ms', inp: 'ms', cls: 'score' })
	}
})

test('field export CLI reads local data and rejects oversized or private input without echoing it', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'field-export-'))
	try {
		const path = join(directory, 'export.json')
		await writeFile(path, JSON.stringify(fixture()))
		assert.equal((await readFieldPerformance(path)).segments[0].metrics.lcp.p75, 30)
		const cli = new URL('../../scripts/field-performance.mjs', import.meta.url)
		const run = () => spawnSync(process.execPath, [fileURLToPath(cli), path], { encoding: 'utf8' })
		const good = run()
		assert.equal(good.status, 0, good.stderr)
		assert.equal(JSON.parse(good.stdout).datasetKind, 'test')
		await writeFile(path, '{"private-user-secret": invalid}')
		const bad = run()
		assert.equal(bad.status, 1)
		assert.equal(bad.stdout, '')
		assert.doesNotMatch(bad.stderr, /private-user-secret|export\.json/)
		await writeFile(path, ' '.repeat(5 * 1024 * 1024) + JSON.stringify(fixture()))
		await assert.rejects(readFieldPerformance(path), /exceeds 5 MiB/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
