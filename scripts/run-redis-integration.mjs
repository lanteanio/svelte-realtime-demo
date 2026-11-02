import { execFile, spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const name = `srd-test-redis-${process.pid}-${Date.now()}`
const image = 'redis:7-alpine@sha256:b1addbe72465a718643cff9e60a58e6df1841e29d6d7d60c9a85d8d72f08d1a7'
let started = false
try {
	await execute('docker', ['run', '--rm', '--detach', '--name', name, '--publish', '127.0.0.1::6379', image])
	started = true
	const { stdout } = await execute('docker', ['port', name, '6379/tcp'])
	const port = stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1]
	if (!port) throw new Error('Redis container did not expose its isolated loopback port')
	const deadline = Date.now() + 10000
	while (true) {
		try {
			const result = await execute('docker', ['exec', name, 'redis-cli', 'ping'])
			if (result.stdout.trim() === 'PONG') break
		} catch (error) {
			if (Date.now() >= deadline) throw error
		}
		if (Date.now() >= deadline) throw new Error('Isolated Redis did not become ready')
		await delay(100)
	}
	const directory = new URL('../test/redis/', import.meta.url)
	const files = (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort()
	if (!files.length) throw new Error('No Redis integration tests found')
	process.exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', ...files.map(name => fileURLToPath(new URL(name, directory)))], {
			stdio: 'inherit', env: { ...process.env, REDIS_TEST_URL: `redis://127.0.0.1:${port}` }
		})
		child.once('error', reject)
		child.once('exit', code => resolve(code ?? 1))
	})
} catch (error) {
	console.error('Redis integration failed:', error.message)
	process.exitCode = 1
} finally {
	if (started) {
		try { await execute('docker', ['stop', name]) }
		catch (error) { console.error('Redis container cleanup failed:', error.message); process.exitCode = 1 }
	}
}
