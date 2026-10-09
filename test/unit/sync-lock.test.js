import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const syncScript = fileURLToPath(new URL('../../scripts/sync.mjs', import.meta.url))
const readRepoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const LOCK = join('node_modules', '.cache', 'srd-build.lock')

// Loaded with --import ahead of scripts/sync.mjs, so its spawn resolves to a
// recorder instead of starting kit. Each spawn is recorded with its command,
// its arguments, its options and whether the lock file at LOCK (relative to
// the working directory) holds this process's pid at that moment. The fake
// child lives 300 ms, as a real sync takes a while, so a lock released before
// the child ends is seen released; it then exits with SRD_TEST_SYNC_EXIT (0
// when unset), or is killed by the signal SRD_TEST_SYNC_SIGNAL names, or fails
// to start with an 'error' when SRD_TEST_SYNC_ERROR is set. How it ended is
// recorded with the lock's state at that moment.
const recorderSource = `
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { appendFileSync, readFileSync } from 'node:fs'
const LOCK = ${JSON.stringify(LOCK)}
const locked = () => {
	try {
		return readFileSync(LOCK, 'utf8').split('\\n')[0].trim() === String(process.pid)
	} catch {
		return false
	}
}
const record = (line) => appendFileSync(process.env.SRD_TEST_SPAWN_RECORD, JSON.stringify(line) + '\\n')
const childProcess = createRequire(import.meta.url)('node:child_process')
childProcess.spawn = (command, args, { env, ...options } = {}) => {
	record({ via: 'spawn', command, args, options, locked: locked() })
	const child = new EventEmitter()
	const code = Number(process.env.SRD_TEST_SYNC_EXIT || 0)
	const signal = process.env.SRD_TEST_SYNC_SIGNAL || null
	setTimeout(() => {
		if (process.env.SRD_TEST_SYNC_ERROR) {
			record({ errored: true, locked: locked() })
			child.emit('error', new Error('spawn failed'))
			return
		}
		record({ exited: signal ? null : code, signal, locked: locked() })
		child.emit('exit', signal ? null : code, signal)
		child.emit('close', signal ? null : code, signal)
	}, 300)
	return child
}
// spawnSync, exec, execSync, execFile, execFileSync, fork and
// ChildProcess.prototype.spawn (which a hand-made ChildProcess calls) each
// record a launch and throw, so a process started through any of them counts
// against exactly one. Not looked at: a sync run in this process or in a
// worker thread, and a process started through process.binding.
for (const via of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
	childProcess[via] = () => {
		record({ via })
		throw new Error('scripts/sync.mjs launched a process through ' + via)
	}
}
childProcess.ChildProcess.prototype.spawn = function () {
	record({ via: 'ChildProcess' })
	throw new Error('scripts/sync.mjs launched a process through ChildProcess')
}
syncBuiltinESMExports()
`

// A working directory of its own for one run, holding the recorder and its
// record, so the lock the script takes there is private to the run.
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'srd-sync-lock-'))
	writeFileSync(join(dir, 'record-spawn.mjs'), recorderSource)
	return {
		dir,
		args: ['--import', pathToFileURL(join(dir, 'record-spawn.mjs')).href, syncScript],
		env: (extra = {}) => ({
			...process.env,
			SRD_TEST_SYNC_EXIT: '',
			SRD_TEST_SYNC_SIGNAL: '',
			SRD_TEST_SYNC_ERROR: '',
			...extra,
			SRD_TEST_SPAWN_RECORD: join(dir, 'record.jsonl')
		}),
		lines: () => existsSync(join(dir, 'record.jsonl'))
			? readFileSync(join(dir, 'record.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
			: [],
		remove: () => rmSync(dir, { recursive: true, force: true })
	}
}

test('npm run check and npm\'s prepare step run svelte-kit sync through scripts/sync.mjs', () => {
	// What is checked: package.json's check script starts with
	// `node scripts/sync.mjs &&`, its prepare script is `node scripts/sync.mjs`
	// with the existing `|| echo ''` fallback, and no script's text, in any
	// letter case, contains `sveltejs`, or `svelte-kit` other than right after
	// a dot (the .svelte-kit directory is not kit's command). Not looked at:
	// kit reached through another spelling of its path (an 8.3 short name, a
	// percent-encoded file URL, quotes or other characters a shell removes
	// inside either word), a name built at run time (a variable, a cmd
	// escape), a wrapper package that runs kit under another name, a vite
	// build or vite dev (which write kit's generated files themselves), and
	// what a script file other than scripts/sync.mjs that a package.json
	// script runs starts.
	const { scripts } = JSON.parse(readRepoFile('package.json'))
	assert.match(scripts.check, /^node scripts\/sync\.mjs && /)
	assert.equal(scripts.prepare, 'node scripts/sync.mjs || echo \'\'')
	const namesKit = /sveltejs|(?<!\.)svelte-kit/i
	assert.deepEqual(Object.entries(scripts).filter(([, command]) => namesKit.test(command)).map(([name]) => name), [],
		'no package.json script may name kit\'s command or package')
})

test('scripts/sync.mjs takes the lock file scripts/build.mjs takes', () => {
	// The literal rule: both files spell the lock path in a top-level
	// `const LOCK = '<path>'`, and the two strings are equal.
	const lockOf = (path) => readRepoFile(path).match(/^const LOCK = '([^']+)'$/m)?.[1]
	assert.ok(lockOf('scripts/build.mjs'), 'scripts/build.mjs must spell its lock path as const LOCK')
	assert.equal(lockOf('scripts/sync.mjs'), lockOf('scripts/build.mjs'))
	assert.equal(join(...lockOf('scripts/build.mjs').split('/')), LOCK, 'the lock path this test uses must be the one the scripts take')
})

test('scripts/sync.mjs runs svelte-kit sync once, holding the lock, and exits with its code', { timeout: 30_000 }, () => {
	for (const exit of ['0', '3']) {
		const run = fixture()
		try {
			const result = spawnSync(process.execPath, run.args, { cwd: run.dir, env: run.env({ SRD_TEST_SYNC_EXIT: exit }), encoding: 'utf8', timeout: 20_000 })
			const spawns = run.lines().filter((line) => 'via' in line)
			assert.equal(spawns.length, 1, `exactly one process must be started: ${result.stderr}`)
			assert.equal(spawns[0].command, process.execPath)
			assert.deepEqual(spawns[0].args, ['node_modules/@sveltejs/kit/svelte-kit.js', 'sync'])
			// Everything but the environment, exactly: the sync's output reaches
			// the operator, and a shell would change what the command means.
			assert.deepEqual(spawns[0].options, { stdio: 'inherit' })
			assert.equal(spawns[0].locked, true, 'svelte-kit sync must start while the build lock holds the script\'s pid')
			assert.deepEqual(run.lines().filter((line) => 'exited' in line), [{ exited: Number(exit), signal: null, locked: true }],
				'the lock must still be held when svelte-kit sync exits, 300 ms after it started')
			assert.equal(result.status, Number(exit), 'scripts/sync.mjs must exit with svelte-kit sync\'s exit code')
			assert.equal(existsSync(join(run.dir, LOCK)), false, 'the lock must be released afterwards')
		} finally {
			run.remove()
		}
	}
})

test('a sync that is killed or cannot start fails scripts/sync.mjs and releases the lock', { timeout: 30_000 }, () => {
	for (const ending of [{ SRD_TEST_SYNC_SIGNAL: 'SIGTERM' }, { SRD_TEST_SYNC_ERROR: '1' }]) {
		const run = fixture()
		try {
			const result = spawnSync(process.execPath, run.args, { cwd: run.dir, env: run.env(ending), encoding: 'utf8', timeout: 20_000 })
			assert.equal(result.status, 1, `${JSON.stringify(ending)} must fail the script: ${result.stderr}`)
			assert.equal(existsSync(join(run.dir, LOCK)), false, 'the lock must be released afterwards')
		} finally {
			run.remove()
		}
	}
})

test('a sync started while a build holds the lock waits for the build', { timeout: 30_000 }, async () => {
	// The lock file is created first, holding this test process's pid (alive,
	// so the lock is not reclaimed). What is checked: no sync is started while
	// it stands, for 2.5 s, which spans at least two of the lock's 1 s polls;
	// once it is removed, the sync starts, holding the lock itself. Not looked
	// at: how long the script would wait (withBuildLock's default, 900 s).
	const run = fixture()
	let child
	let exited
	try {
		mkdirSync(join(run.dir, 'node_modules', '.cache'), { recursive: true })
		writeFileSync(join(run.dir, LOCK), `${process.pid}\n${new Date().toISOString()}\n`)
		child = spawn(process.execPath, run.args, { cwd: run.dir, env: run.env(), stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		child.stdout.on('data', (chunk) => { output += chunk })
		child.stderr.on('data', (chunk) => { output += chunk })
		exited = new Promise((resolve) => child.once('exit', resolve))
		await new Promise((resolve) => setTimeout(resolve, 2_500))
		assert.deepEqual(run.lines().filter((line) => 'via' in line), [], 'no sync may start while another holder has the lock')
		assert.match(output, new RegExp(`build lock: waiting for the build held by pid ${process.pid}`))
		unlinkSync(join(run.dir, LOCK))
		assert.equal(await exited, 0, output)
		const spawns = run.lines().filter((line) => 'via' in line)
		assert.equal(spawns.length, 1)
		assert.equal(spawns[0].locked, true, 'the sync must start holding the lock once the build has released it')
	} finally {
		// A failure before the lock is removed leaves the script waiting on it,
		// with the fixture as its working directory: end it first, or it waits
		// out its own timeout, and on Windows the fixture cannot be removed while
		// it is a running process's working directory.
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill()
			await exited
		}
		run.remove()
	}
})
