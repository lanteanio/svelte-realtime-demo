import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const specs = readdirSync(new URL('../e2e/', import.meta.url))
const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@playwright/test/package.json')))
// These two files log measurements rather than assert the product outcome.
// A new underscore-prefixed cluster file needs an explicit classification.
const clusterDiagnostics = ['_mp-cursor-trailing-probe.cluster.spec.js', '_schema-order-probe.cluster.spec.js']

function discovered(project) {
	const result = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', `--project=${project}`], {
		cwd: root,
		encoding: 'utf8',
		timeout: 30_000,
		maxBuffer: 10 * 1024 * 1024,
		env: {
			...process.env,
			CI: '1',
			E2E_OPTIONAL_PROJECT: project,
			BASE_URL: 'http://127.0.0.1:4301',
			INSTANCE_B: 'http://127.0.0.1:4302',
			INSTANCE_C: 'http://127.0.0.1:4303',
			INSTANCE_D: 'http://127.0.0.1:4304',
			SCHEMA_ORDER_PROBE: '1'
		}
	})
	assert.ifError(result.error)
	assert.equal(result.status, 0, `${project} discovery failed: ${result.stderr}\n${result.stdout}`)
	const report = JSON.parse(result.stdout)
	assert.deepEqual(report.errors, [], project)
	function hasTests(suite) {
		return suite.specs.length > 0 || (suite.suites ?? []).some(hasTests)
	}
	// The outer suite names the discovered file; a test's source location can
	// point into a shared helper that declares tests for several entry files.
	return report.suites.filter(hasTests).map((suite) => basename(suite.file)).sort()
}

test('the cluster project discovers every functional cluster file without diagnostic probes', () => {
	const expected = specs.filter((name) => name.endsWith('.cluster.spec.js') && !clusterDiagnostics.includes(name))
	expected.push('cluster-probe.spec.js', 'cluster-bugs-probe.spec.js')
	assert.ok(expected.length > 30, 'the functional inventory must contain the per-page cluster suite')
	assert.deepEqual(discovered('cluster'), expected.sort())
})

test('the diagnostics project retains both cross-replica measurement probes', () => {
	const found = discovered('diagnostics')
	assert.deepEqual(found, specs.filter((name) => name.startsWith('_') && name.endsWith('.spec.js')).sort())
	for (const name of clusterDiagnostics) assert.ok(found.includes(name), `${name} must remain selectable`)
})

test('safe projects exclude all cluster files and diagnostic probes', () => {
	for (const project of ['main', 'isolated']) {
		const found = discovered(project)
		assert.ok(found.length > 0, `${project} must discover tests`)
		assert.deepEqual(found.filter((name) => name.startsWith('_') || name.endsWith('.cluster.spec.js') ||
			['cluster-probe.spec.js', 'cluster-bugs-probe.spec.js'].includes(name)), [], project)
	}
})
