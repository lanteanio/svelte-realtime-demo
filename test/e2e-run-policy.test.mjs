import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
	parsePlaywrightFilters, playwrightArguments, validatePlaywrightReport, readPlaywrightResult
} from '../scripts/e2e-run-policy.mjs'

function spec(title = 'board updates reach another browser', file = 'realtime-sync.spec.js', project = 'main') {
	return {
		title, file, ok: true,
		tests: [{
			projectName: project, expectedStatus: 'passed', status: 'expected',
			results: [{ status: 'passed', errors: [], retry: 0, workerIndex: 0 }]
		}]
	}
}

function report(specs = [spec()]) {
	return {
		suites: [{ specs: [], suites: [{ specs }] }], errors: [],
		stats: { expected: specs.length, skipped: 0, unexpected: 0, flaky: 0 }
	}
}

function skipped(title, file, project = 'isolated') {
	const value = spec(title, file, project)
	Object.assign(value.tests[0], { expectedStatus: 'skipped', status: 'skipped' })
	Object.assign(value.tests[0].results[0], { status: 'skipped', workerIndex: -1 })
	return value
}

test('only grep filters are forwarded, including equals inside patterns', () => {
	assert.deepEqual(parsePlaywrightFilters(['--grep', 'board|notes', '--grep-invert=mode=slow']), [
		'--grep=board|notes', '--grep-invert=mode=slow'
	])
	assert.deepEqual(parsePlaywrightFilters(['--grep=--output=elsewhere']), ['--grep=--output=elsewhere'])
})

test('configuration, output paths, empty suites, and files cannot be supplied as runner arguments', () => {
	for (const args of [
		['-c', 'other.config.js'], ['--config=other.config.js'], ['--output', '../user-files'],
		['--output=../user-files'], ['--pass-with-no-tests'], ['--list'], ['--project=other'],
		['--reporter=null'], ['--workers=9'], ['--retries=1'], ['e2e/home.spec.js'], ['--'],
		['--grep', '--output=../user-files'], ['--grep'], ['--grep='], ['--grep', '['],
		['--grep=a', '--grep=b'], ['-g', 'board']
	]) assert.throws(() => parsePlaywrightFilters(args), undefined, JSON.stringify(args))
})

test('owned Playwright options follow every filter', () => {
	const args = playwrightArguments({
		project: 'main', configFile: '/checkout/playwright.config.js', outputDir: '/checkout/test-results/run/main',
		filters: ['--grep', 'boards']
	})
	assert.deepEqual(args.slice(2), [
		'--grep=boards', '--config=/checkout/playwright.config.js', '--project=main',
		'--output=/checkout/test-results/run/main', '--workers=1', '--retries=0', '--reporter=list,json'
	])
	assert.throws(() => playwrightArguments({ project: 'main', filters: ['--output=elsewhere'] }), /Unsupported/)
})

test('passing reports count nested executed tests', () => {
	assert.deepEqual(validatePlaywrightReport(report(), 'main'), { executed: 1, skipped: [] })
})

test('only the two named isolated destroyer tests may skip', () => {
	const value = report([
		spec('alone on the page', 'demos-auctions.spec.js', 'isolated'),
		skipped('ramp to 10K users - find the ceiling', 'destroyer.spec.js'),
		skipped('ramp to 10K connections - find presence ceiling', 'destroyer-presence.spec.js')
	])
	value.stats.expected = 1
	value.stats.skipped = 2
	const summary = validatePlaywrightReport(value, 'isolated')
	assert.equal(summary.executed, 1)
	assert.equal(summary.skipped.length, 2)
	for (const mutate of [
		(v) => { v.suites[0].suites[0].specs[1].file = 'other/destroyer.spec.js' },
		(v) => { v.suites[0].suites[0].specs[1].title = 'another destroyer test' },
		(v) => { v.suites[0].suites[0].specs[1].tests[0].results[0].status = 'failed' }
	]) {
		const changed = structuredClone(value)
		mutate(changed)
		assert.throws(() => validatePlaywrightReport(changed, 'isolated'), /Unexpected skipped/)
	}
})

test('a jobs-unavailable skip fails even when Playwright would exit successfully', () => {
	const value = report([spec(), skipped('jobs finish', 'demos-jobs.spec.js', 'main')])
	value.stats.expected = 1
	value.stats.skipped = 1
	assert.throws(() => validatePlaywrightReport(value, 'main'), /Unexpected skipped test/)
})

test('zero tests and an all-allowed-skips report cannot qualify', () => {
	assert.throws(() => validatePlaywrightReport(report([]), 'main'), /No tests executed/)
	const value = report([skipped('ramp to 10K users - find the ceiling', 'destroyer.spec.js')])
	value.stats.expected = 0
	value.stats.skipped = 1
	assert.throws(() => validatePlaywrightReport(value, 'isolated'), /No tests executed/)
})

test('failures, expected failures, interruption, retries and flaky outcomes fail qualification', () => {
	for (const mutate of [
		(t) => { t.status = 'unexpected'; t.results[0].status = 'failed' },
		(t) => { t.expectedStatus = 'failed'; t.results[0].status = 'failed' },
		(t) => { t.results[0].status = 'interrupted' },
		(t) => { t.status = 'flaky' },
		(t) => { t.results.push({ ...t.results[0], retry: 1 }) },
		(t) => { t.results[0].retry = 1 },
		(t) => { t.results[0].workerIndex = -1 },
		(t) => { t.results[0].errors = [{ message: 'afterAll failed' }] },
		(t) => { t.results[0].error = { message: 'worker failed' } },
		(t) => { t.results = [] }
	]) {
		const value = report()
		mutate(value.suites[0].suites[0].specs[0].tests[0])
		assert.throws(() => validatePlaywrightReport(value, 'main'))
	}
})

test('global errors and contradictory summary counts fail qualification', () => {
	const value = report()
	value.errors.push({ message: 'global teardown failed' })
	assert.throws(() => validatePlaywrightReport(value, 'main'), /global error/)
	for (const field of ['expected', 'skipped', 'unexpected', 'flaky']) {
		const changed = report()
		changed.stats[field]++
		assert.throws(() => validatePlaywrightReport(changed, 'main'), /summary/)
	}
	assert.throws(() => validatePlaywrightReport(report(), 'isolated'), /Unexpected project/)
	assert.throws(() => validatePlaywrightReport({}, 'main'), /Invalid Playwright/)
})

test('exit zero requires a readable valid report; valid reports also require exit zero', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'srd-report-test-'))
	const reportFile = path.join(directory, 'main.json')
	try {
		await assert.rejects(readPlaywrightResult(reportFile, 'main', 0), /Cannot read Playwright report/)
		await writeFile(reportFile, '{incomplete')
		await assert.rejects(readPlaywrightResult(reportFile, 'main', 0), /Cannot read Playwright report/)
		await writeFile(reportFile, JSON.stringify(report()))
		assert.equal((await readPlaywrightResult(reportFile, 'main', 0)).executed, 1)
		await assert.rejects(readPlaywrightResult(reportFile, 'main', 1), /exited 1/)
	} finally {
		await rm(reportFile, { force: true })
		await rm(directory, { recursive: true })
	}
})
