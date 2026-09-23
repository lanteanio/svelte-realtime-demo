import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
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

test('every evaluation of the config under one pinned build agrees on version.name', async () => {
	assert.deepEqual(await versionsUnder('pinned-for-this-test'), ['pinned-for-this-test', 'pinned-for-this-test'])
})

test('the build hands vite a pinned version, and the config reads exactly that version', async () => {
	// The half the config test above cannot see: that the build actually
	// produces the pin and passes it to the process that evaluates the config.
	// An environment without it falls back to Date.now() per evaluation, which
	// is the wall this pin exists to prevent.
	const calls = []
	assert.equal(await viteBuild({ base: { PATH: 'unchanged' }, spawn: fakeSpawn(calls) }), 0)
	assert.equal(calls.length, 1)
	assert.equal(calls[0].command, process.execPath)
	assert.deepEqual(calls[0].args, ['node_modules/vite/bin/vite.js', 'build'])
	const { env } = calls[0].options
	assert.equal(env.PATH, 'unchanged')
	assert.match(env.SRD_BUILD_VERSION ?? '', /^\d+$/, 'the build must pin a version before vite runs')
	assert.deepEqual(await versionsUnder(env.SRD_BUILD_VERSION), [env.SRD_BUILD_VERSION, env.SRD_BUILD_VERSION])
})

test('a version supplied by the operator reaches vite unchanged', async () => {
	const calls = []
	await viteBuild({ base: { SRD_BUILD_VERSION: 'release-7' }, spawn: fakeSpawn(calls) })
	assert.equal(calls[0].options.env.SRD_BUILD_VERSION, 'release-7')
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
