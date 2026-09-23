import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { viteBuild } from '../../scripts/vite-build.mjs'

// The failure this exists for: kit compiles the client's hydration-payload
// access to globalThis.__sveltekit_<hash(version.name)>, and version.name
// defaults to Date.now() at config evaluation - so a config evaluated more
// than once inside a single build can ship a client that reads another
// evaluation's global and hydrates nothing on any page. The property under
// test is agreement: however many times the config is evaluated under one
// pinned build environment, every evaluation resolves the same version.
//
// Each import carries a cache-busting query so it genuinely re-evaluates the
// module rather than replaying the first evaluation from the module cache -
// without that, the second read is the first one wearing a disguise and the
// test cannot fail.

const configHref = new URL('../../svelte.config.js', import.meta.url).href
const buildScript = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url))
let evaluation = 0

async function versionsUnder(version) {
	process.env.SRD_BUILD_VERSION = version
	try {
		const first = (await import(`${configHref}?evaluation=${++evaluation}`)).default
		const second = (await import(`${configHref}?evaluation=${++evaluation}`)).default
		return [first.kit.version.name, second.kit.version.name]
	} finally {
		delete process.env.SRD_BUILD_VERSION
	}
}

// Stands in for child_process.spawn: records what the build hands the child,
// then exits the way `outcome` says.
function fakeSpawn(calls, outcome = (child) => child.emit('exit', 0, null)) {
	return (command, args, options) => {
		calls.push({ command, args, options })
		const child = new EventEmitter()
		queueMicrotask(() => outcome(child))
		return child
	}
}

// Loaded with --import ahead of scripts/build.mjs, so the build's own import
// of spawn resolves to a recorder instead of launching vite.
const RECORDER = `
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
const childProcess = createRequire(import.meta.url)('node:child_process')
childProcess.spawn = (command, args, options) => {
	writeFileSync(process.env.SRD_TEST_SPAWN_RECORD, JSON.stringify({ command, args, stdio: options.stdio, env: options.env }))
	const child = new EventEmitter()
	queueMicrotask(() => child.emit('exit', 0, null))
	return child
}
syncBuiltinESMExports()
`

// Run the real `npm run build` entry point, with nothing between it and the
// spawn but the recorder. The working directory is an empty temp dir, so the
// build lock is private to this run and no vite is reachable from it even if
// the recorder failed to take the place of spawn.
function runBuildScript(env) {
	const dir = mkdtempSync(join(tmpdir(), 'srd-build-pin-'))
	try {
		const recorder = join(dir, 'record-spawn.mjs')
		const record = join(dir, 'spawn.json')
		writeFileSync(recorder, RECORDER)
		const parentEnv = { ...process.env }
		delete parentEnv.SRD_BUILD_VERSION
		delete parentEnv.DEMO_NEWS_WEBHOOK_SECRET
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(recorder).href, buildScript], {
			cwd: dir,
			env: { ...parentEnv, ...env, SRD_TEST_SPAWN_RECORD: record },
			encoding: 'utf8'
		})
		assert.equal(result.status, 0, `build script failed: ${result.stderr}`)
		return JSON.parse(readFileSync(record, 'utf8'))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('every evaluation of the config under one pinned build agrees on version.name', async () => {
	assert.deepEqual(await versionsUnder('pinned-for-this-test'), ['pinned-for-this-test', 'pinned-for-this-test'])
})

test('npm run build hands vite a pinned version, and the config reads exactly that version', async () => {
	// The half the config test above cannot see: that the build actually
	// produces the pin and passes it to the process that evaluates the config.
	// An environment without it falls back to Date.now() per evaluation, which
	// is the failure this pin exists to prevent. Driven through the real entry
	// point, so the defaults it relies on are the ones under test.
	const child = runBuildScript({ SRD_TEST_SENTINEL: 'passed-through' })
	assert.equal(child.command, process.execPath)
	assert.deepEqual(child.args, ['node_modules/vite/bin/vite.js', 'build'])
	assert.equal(child.stdio, 'inherit', 'vite output must reach the operator, and an unread pipe can stall it')
	assert.equal(child.env.SRD_TEST_SENTINEL, 'passed-through', 'the build must run under the caller\'s environment')
	assert.equal(child.env.DEMO_NEWS_WEBHOOK_SECRET, 'build-analysis-only')
	assert.match(child.env.SRD_BUILD_VERSION ?? '', /^\d+$/, 'the build must pin a version before vite runs')
	assert.deepEqual(await versionsUnder(child.env.SRD_BUILD_VERSION), [child.env.SRD_BUILD_VERSION, child.env.SRD_BUILD_VERSION])
})

test('a version supplied by the operator reaches vite unchanged', () => {
	assert.equal(runBuildScript({ SRD_BUILD_VERSION: 'release-7' }).env.SRD_BUILD_VERSION, 'release-7')
})

test('an empty version is replaced, not passed through', async () => {
	// What an unset Docker ARG forwarded through ENV produces. Passed through,
	// the config would see an empty value and fall back to Date.now() on every
	// evaluation.
	const calls = []
	await viteBuild({ base: { SRD_BUILD_VERSION: '' }, spawn: fakeSpawn(calls) })
	assert.match(calls[0].options.env.SRD_BUILD_VERSION, /^\d+$/)
})

test('each build invocation gets its own version', async () => {
	const calls = []
	await viteBuild({ base: {}, spawn: fakeSpawn(calls) })
	await new Promise((resolve) => setTimeout(resolve, 5))
	await viteBuild({ base: {}, spawn: fakeSpawn(calls) })
	assert.notEqual(calls[0].options.env.SRD_BUILD_VERSION, calls[1].options.env.SRD_BUILD_VERSION)
})

test('the build resolves vite\'s exit code, and 1 for a signal or a spawn failure', async () => {
	const quiet = console.error
	console.error = () => {}
	try {
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => child.emit('exit', 2, null)) }), 2)
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => child.emit('exit', null, 'SIGTERM')) }), 1)
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => child.emit('error', new Error('ENOENT'))) }), 1)
	} finally {
		console.error = quiet
	}
})
