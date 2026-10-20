import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, cp, mkdir, open, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parsePlaywrightFilters, playwrightArguments, readPlaywrightResult } from './e2e-run-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const tier = args.shift() || 'all'
const skipBuild = args.includes('--skip-build')
const forwarded = parsePlaywrightFilters(args.filter((arg) => arg !== '--skip-build'))
if (!['all', 'main', 'isolated'].includes(tier)) {
	throw new Error('Usage: node scripts/run-local-e2e.mjs [all|main|isolated] [--skip-build] [--grep pattern] [--grep-invert pattern]')
}

const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`
const postgresName = `srd-local-pg-${suffix}`
const redisName = `srd-local-redis-${suffix}`
const lockPath = path.join(root, 'node_modules', '.local-e2e.lock')
const buildDir = path.join(root, 'node_modules', `.local-e2e-build-${suffix}`)
const outputDir = path.join(root, 'test-results', suffix)
const containers = new Set()
const children = new Set()
const apps = new Set()
let lock
let cleanupPromise
let interrupted = false

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		interrupted = true
		cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
	})
}

try {
	// Vite loads .env even with an explicit mode. Refuse deployment files here.
	const envFiles = (await readdir(root)).filter((name) => name === '.env' ||
		(name.startsWith('.env.') && !name.startsWith('.env.example')))
	if (envFiles.length) throw new Error(`Use a checkout without dotenv files: ${envFiles.join(', ')}`)
	try {
		lock = await open(lockPath, 'wx')
		await lock.writeFile(`${process.pid}\n`)
	} catch (error) {
		if (error.code === 'EEXIST') throw new Error('Another local E2E run owns this checkout. Do not rebuild while it is serving.')
		throw error
	}
	await checked('Docker availability', 'docker', ['info'], { quiet: true })
	await checked('PostgreSQL container', 'docker', [
		'run', '--detach', '--name', postgresName, '--label', `srd-local-e2e=${suffix}`,
		'--publish', '127.0.0.1::5432', '--memory', '512m', '--cpus', '1',
		'--env', 'POSTGRES_PASSWORD=test', '--env', 'POSTGRES_DB=stickynotes',
		'postgres:16-alpine'
	], { trackContainer: postgresName })
	await checked('Redis container', 'docker', [
		'run', '--detach', '--name', redisName, '--label', `srd-local-e2e=${suffix}`,
		'--publish', '127.0.0.1::6379', '--memory', '256m', '--cpus', '1',
		'redis:7-alpine'
	], { trackContainer: redisName })
	const postgresPort = await containerPort(postgresName, '5432/tcp')
	const redisPort = await containerPort(redisName, '6379/tcp')
	const env = localEnvironment(postgresPort, redisPort)
	await waitFor('PostgreSQL', async () => (await command('docker', [
		'exec', postgresName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'stickynotes'
	], { quiet: true })).code === 0)
	await waitFor('Redis', async () => (await command('docker', ['exec', redisName, 'redis-cli', 'ping'], { quiet: true })).stdout.trim() === 'PONG')
	await checked('application role', 'docker', [
		'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stickynotes', '-c',
		"CREATE ROLE stickynotes_app LOGIN PASSWORD 'test'; GRANT USAGE, CREATE ON SCHEMA public TO stickynotes_app;"
	])
	await checked('schema copy', 'docker', ['cp', path.join(root, 'schema.sql'), `${postgresName}:/tmp/schema.sql`])
	await checked('schema initialization', 'docker', [
		'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stickynotes', '-f', '/tmp/schema.sql'
	])
	if (!skipBuild) await checked('production build', process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { env })
	await access(path.join(root, 'build', 'index.js'))
	// Serve a private copy so a separate build cannot overwrite a running server.
	await cp(path.join(root, 'build'), buildDir, { recursive: true })
	await mkdir(outputDir, { recursive: true })
	const portA = await freePort()
	let portB = await freePort()
	while (portB === portA) portB = await freePort()
	const baseURL = `http://localhost:${portA}`
	const instanceB = `http://localhost:${portB}`
	console.log(`Production servers: ${baseURL} and ${instanceB}`)
	if (forwarded.length) console.log(`Filtered run: ${forwarded.join(' ')}. This does not qualify the full suite.`)
	const results = []
	for (const project of tier === 'all' ? ['main', 'isolated'] : [tier]) {
		await stopApps()
		await checked('clear test Redis', 'docker', ['exec', redisName, 'redis-cli', 'FLUSHALL'])
		await checked('reset test schema', 'docker', [
			'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stickynotes', '-c',
			'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE, CREATE ON SCHEMA public TO stickynotes_app;'
		])
		await checked('initialize test schema', 'docker', [
			'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stickynotes', '-f', '/tmp/schema.sql'
		])
		await startApp(baseURL, portA, env)
		await startApp(instanceB, portB, env)
		await waitFor('application PostgreSQL initialization', async () => {
			const result = await command('docker', [
				'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'stickynotes', '-At', '-c',
				"SELECT count(*) FROM board WHERE slug = 'stress-me-out';"
			], { quiet: true })
			return result.code === 0 && result.stdout.trim() === '1'
		})
		await waitFor('application Redis connections', async () => {
			const result = await command('docker', ['exec', redisName, 'redis-cli', 'CLIENT', 'LIST'], { quiet: true })
			const clients = result.stdout.trim().split('\n').filter((line) => line && !line.includes('cmd=client|list'))
			return result.code === 0 && clients.length >= 2
		})
		const reportFile = path.join(outputDir, `${project}.json`)
		const result = await command(process.execPath, playwrightArguments({
			project, configFile: path.join(root, 'playwright.config.js'),
			outputDir: path.join(outputDir, project), filters: forwarded
		}), {
			timeout: 3_600_000,
			env: {
				...env, BASE_URL: baseURL, INSTANCE_B: instanceB, RUN_DESTROYER: '',
				PLAYWRIGHT_HTML_OPEN: 'never', PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile
			}
		})
		try {
			const summary = await readPlaywrightResult(reportFile, project, result.code)
			console.log(`${project}: ${summary.executed} passed; ${summary.skipped.length} allowed skips`)
			for (const label of summary.skipped) console.log(`  SKIP ${label}`)
			results.push({ project, code: 0 })
		} catch (error) {
			console.error(`${project}: ${error.message}`)
			results.push({ project, code: 1 })
		}
	}
	for (const { project, code } of results) console.log(`${project}: exit ${code}`)
	console.log('The opt-in 10K-connection destroyer tests were not enabled. Run those only on a resource-isolated host.')
	process.exitCode = results.every(({ code }) => code === 0) ? 0 : 1
} catch (error) {
	console.error(error)
	process.exitCode = 1
} finally {
	await cleanup()
}

function localEnvironment(postgresPort, redisPort) {
	const env = { ...process.env }
	for (const key of Object.keys(env)) {
		if (/^(?:SSL_|CLUSTER_|DEMO_|DATABASE_URL$|REDIS_URL$|ORIGIN$|HOST$|PORT$|NODE_OPTIONS$|BASE_URL$|INSTANCE_|RUN_DESTROYER$|ALLOW_REMOTE_E2E$|WORKERS$)/.test(key)) delete env[key]
	}
	return {
		...env, NODE_ENV: 'production', LOCAL_E2E: '1', ALLOW_REMOTE_E2E: '0',
		DATABASE_URL: `postgres://stickynotes_app:test@127.0.0.1:${postgresPort}/stickynotes`,
		REDIS_URL: `redis://127.0.0.1:${redisPort}`,
		DEMO_NEWS_WEBHOOK_SECRET: 'local-test-secret', METRICS_SCRAPE_TOKEN: 'local-test-token',
		DEMO_PURGE_INTERVAL_MIN: '0', DEMO_UPLOAD_PURGE_INTERVAL_MIN: '0',
		PLAYWRIGHT_HTML_OPEN: 'never'
	}
}

async function startApp(baseURL, port, env) {
	const child = spawn(process.execPath, [path.join(buildDir, 'index.js')], {
		cwd: root, env: { ...env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: baseURL },
		stdio: 'inherit', windowsHide: true
	})
	children.add(child)
	apps.add(child)
	child.once('exit', () => { children.delete(child); apps.delete(child) })
	let spawnError
	child.once('error', (error) => { spawnError = error })
	await waitFor(baseURL, async () => {
		if (spawnError) throw spawnError
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server ${baseURL} exited before becoming ready`)
		try {
			const response = await fetch(`${baseURL}/board/stress-me-out`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
			await response.arrayBuffer()
			return response.status === 200
		} catch { return false }
	})
}

async function freePort() {
	const server = createServer()
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
	const port = server.address().port
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
	return port
}

async function containerPort(name, port) {
	const result = await command('docker', ['port', name, port], { quiet: true })
	if (result.code !== 0 || !/^127\.0\.0\.1:\d+\s*$/.test(result.stdout)) throw new Error(`Unexpected Docker port mapping for ${name}`)
	return Number(result.stdout.trim().split(':').at(-1))
}

async function waitFor(label, ready) {
	const deadline = Date.now() + 60_000
	while (Date.now() < deadline && !interrupted) {
		if (await ready()) return
		await delay(300)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

function command(executable, commandArgs, options = {}) {
	if (options.trackContainer) containers.add(options.trackContainer)
	return new Promise((resolve, reject) => {
		const child = spawn(executable, commandArgs, {
			cwd: root, env: options.env || process.env, windowsHide: true,
			timeout: options.timeout ?? 300_000,
			stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		})
		children.add(child)
		let stdout = ''
		child.stdout?.on('data', (chunk) => { stdout += chunk })
		child.stderr?.resume()
		child.once('error', (error) => { children.delete(child); reject(error) })
		child.once('close', (code) => { children.delete(child); resolve({ code: code ?? 1, stdout }) })
	})
}

async function checked(label, executable, commandArgs, options) {
	const result = await command(executable, commandArgs, options)
	if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code})`)
	return result
}

function cleanup() {
	return cleanupPromise ??= (async () => {
		for (const child of [...children]) await stopChild(child)
		for (const name of containers) await command('docker', ['rm', '--force', '--volumes', name], { quiet: true }).catch(() => {})
		if (path.dirname(buildDir) !== path.join(root, 'node_modules')) throw new Error('Invalid temporary build path')
		await rm(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
		if (lock) { await lock.close(); await rm(lockPath, { force: true }) }
	})()
}

async function stopChild(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
	if (process.platform === 'win32') {
		await command('taskkill', ['/pid', String(child.pid), '/T', '/F'], { quiet: true }).catch(() => {})
	} else {
		child.kill('SIGTERM')
		await Promise.race([new Promise((resolve) => child.once('close', resolve)), delay(5000)])
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
	}
}

async function stopApps() {
	for (const child of [...apps]) await stopChild(child)
}
