import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const name = `srd-undo-postgres-${process.pid}-${Date.now()}`
const image = process.env.TEST_POSTGRES_IMAGE
	|| 'postgres:17-alpine@sha256:5a6fcbc5d93831991d2386fa634509b3c49a1ac5ffb70c13c2322840f821d7e7'
let child
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		interrupted = true
		child?.kill('SIGTERM')
	})
}

function run(command, args, { env = process.env, capture = false, cleanup = false } = {}) {
	if (interrupted && !cleanup) return Promise.reject(new Error('PostgreSQL integration interrupted'))
	return new Promise((resolve, reject) => {
		const running = spawn(command, args, { cwd: root, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] })
		child = running
		let output = ''
		running.stdout?.on('data', data => { output += data })
		const timeout = setTimeout(() => running.kill('SIGKILL'), 180_000)
		running.on('error', error => { clearTimeout(timeout); reject(error) })
		running.on('close', (code, signal) => {
			clearTimeout(timeout)
			if (child === running) child = undefined
			if (code === 0) resolve(output.trim())
			else reject(new Error(`${command} ${args[0]} failed (${signal ?? code})`))
		})
	})
}

try {
	// Docker allocates the loopback port, avoiding a probe-then-bind race.
	await run('docker', ['run', '--detach', '--rm', '--name', name,
		'--label', 'srdemo.test=note-undo', '--publish', '127.0.0.1::5432',
		'--env', 'POSTGRES_PASSWORD=test', '--env', 'POSTGRES_DB=stickynotes', image], { capture: true })
	const address = await run('docker', ['port', name, '5432/tcp'], { capture: true })
	if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`Unexpected PostgreSQL address: ${address}`)
	let ready = false
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			await run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'stickynotes'], { capture: true })
			ready = true
			break
		} catch (error) {
			if (interrupted) throw error
			await delay(500)
		}
	}
	if (!ready) throw new Error('Disposable PostgreSQL did not become ready')
	const databaseURL = `postgres://postgres:test@${address}/stickynotes`
	const env = { ...process.env, DATABASE_URL: databaseURL, NOTE_UNDO_TEST_DATABASE_URL: databaseURL }
	await run(process.execPath, ['scripts/migrate.mjs'], { env })
	await run(process.execPath, ['--test', 'test/integration/note-undo.postgres.test.js'], { env })
} catch (error) {
	console.error(error.message)
	process.exitCode = interrupted ? 130 : 1
} finally {
	try {
		await run('docker', ['rm', '--force', '--volumes', name], { capture: true, cleanup: true })
	} catch (error) {
		console.error(`Could not remove ${name}: ${error.message}`)
		process.exitCode ||= 1
	}
}
