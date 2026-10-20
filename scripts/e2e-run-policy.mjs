import { readFile } from 'node:fs/promises'

const FILTERS = new Set(['--grep', '--grep-invert'])
const ALLOWED_SKIPS = new Map([
	['destroyer.spec.js', 'ramp to 10K users - find the ceiling'],
	['destroyer-presence.spec.js', 'ramp to 10K connections - find presence ceiling']
])

/** Keep test selection separate from the runner's configuration and output paths. */
export function parsePlaywrightFilters(args) {
	const filters = []
	const seen = new Set()
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		const equals = argument.indexOf('=')
		const name = equals < 0 ? argument : argument.slice(0, equals)
		if (!FILTERS.has(name)) throw new Error(`Unsupported Playwright argument: ${argument}`)
		if (seen.has(name)) throw new Error(`Duplicate Playwright filter: ${name}`)
		seen.add(name)
		const value = equals < 0 ? args[++index] : argument.slice(equals + 1)
		if (!value || (equals < 0 && value.startsWith('-'))) throw new Error(`${name} requires a pattern`)
		try { new RegExp(value) } catch { throw new Error(`Invalid regular expression for ${name}`) }
		filters.push(`${name}=${value}`)
	}
	return filters
}

export function playwrightArguments({ project, configFile, outputDir, filters = [] }) {
	if (!['main', 'isolated'].includes(project)) throw new Error(`Unsupported project: ${project}`)
	return [
		'node_modules/@playwright/test/cli.js', 'test', ...parsePlaywrightFilters(filters),
		`--config=${configFile}`, `--project=${project}`, `--output=${outputDir}`,
		'--workers=1', '--retries=0', '--reporter=list,json'
	]
}

/** Require real passing attempts; expected failures and missing tests are not green. */
export function validatePlaywrightReport(report, project) {
	if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || !report.stats) {
		throw new Error('Invalid Playwright JSON report')
	}
	if (report.errors.length) throw new Error(`Playwright reported ${report.errors.length} global error(s)`)
	let executed = 0
	const skipped = []
	for (const spec of specsIn(report.suites)) {
		if (!Array.isArray(spec.tests) || !spec.tests.length) throw new Error(`Missing tests for ${spec.title}`)
		for (const test of spec.tests) {
			const label = `${spec.file}: ${spec.title}`
			if (test.projectName !== project) throw new Error(`Unexpected project for ${label}`)
			if (!Array.isArray(test.results) || test.results.length !== 1) throw new Error(`Expected one attempt for ${label}`)
			const result = test.results[0]
			if (!Array.isArray(result.errors) || result.errors.length || result.error) throw new Error(`Test errors in ${label}`)
			if (test.status === 'skipped') {
				if (project !== 'isolated' || ALLOWED_SKIPS.get(spec.file) !== spec.title ||
					test.expectedStatus !== 'skipped' || result.status !== 'skipped') {
					throw new Error(`Unexpected skipped test: ${label}`)
				}
				if (skipped.includes(label)) throw new Error(`Duplicate skipped test: ${label}`)
				skipped.push(label)
				continue
			}
			if (spec.ok !== true || test.status !== 'expected' || test.expectedStatus !== 'passed' ||
				result.status !== 'passed' || result.retry !== 0 || !Number.isInteger(result.workerIndex) || result.workerIndex < 0) {
				throw new Error(`Test did not pass on its first attempt: ${label}`)
			}
			executed++
		}
	}
	if (!executed) throw new Error('No tests executed successfully')
	if (report.stats.expected !== executed || report.stats.skipped !== skipped.length ||
		report.stats.unexpected !== 0 || report.stats.flaky !== 0) {
		throw new Error('Playwright summary does not match the passing test results')
	}
	return { executed, skipped }
}

export async function readPlaywrightResult(reportFile, project, exitCode) {
	let report
	try { report = JSON.parse(await readFile(reportFile, 'utf8')) } catch (error) {
		throw new Error(`Cannot read Playwright report ${reportFile}: ${error.message}`)
	}
	const summary = validatePlaywrightReport(report, project)
	if (exitCode !== 0) throw new Error(`Playwright exited ${exitCode}`)
	return summary
}

function* specsIn(suites) {
	for (const suite of suites) {
		if (!Array.isArray(suite.specs)) throw new Error('Invalid Playwright suite')
		yield* suite.specs
		if (suite.suites !== undefined) {
			if (!Array.isArray(suite.suites)) throw new Error('Invalid nested Playwright suites')
			yield* specsIn(suite.suites)
		}
	}
}
