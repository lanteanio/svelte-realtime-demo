import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const tier = process.argv[2]
const playwrightArgs = process.argv.slice(3)
const TIERS = new Set(['main', 'safe', 'isolated', 'cluster', 'resilience', 'stress', 'destroyer', 'diagnostics', 'complete'])
if (!TIERS.has(tier)) {
	console.error('Usage: node scripts/run-local-e2e.mjs <main|safe|isolated|cluster|resilience|stress|destroyer|diagnostics|complete>')
	process.exit(2)
}

const suffix = `${process.pid}-${Date.now()}`
const postgresName = `srd-test-postgres-${suffix}`
const redisName = `srd-test-redis-${suffix}`
const postgresImage = process.env.TEST_POSTGRES_IMAGE
	|| 'postgres:17-alpine@sha256:5a6fcbc5d93831991d2386fa634509b3c49a1ac5ffb70c13c2322840f821d7e7'
const redisImage = process.env.TEST_REDIS_IMAGE
	|| 'redis:7-alpine@sha256:b1addbe72465a718643cff9e60a58e6df1841e29d6d7d60c9a85d8d72f08d1a7'
const reservedPorts = new Set()
const postgresPort = await freePort()
const redisPort = await freePort()
const databaseURL = `postgres://postgres:test@127.0.0.1:${postgresPort}/stickynotes`
const redisURL = `redis://127.0.0.1:${redisPort}`
const apps = []
const results = []
let cleaning = false
const selectedProjects = projectsFor(tier)

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		cleanup().finally(() => process.exit(130))
	})
}

try {
	if (selectedProjects.some((project) => project === 'stress' || project === 'destroyer')) {
		await ensureProductionBuild()
	}
	await provisionDependencies()

	for (const project of selectedProjects) {
		try {
			// Every tier gets a clean database, Redis keyspace, and process
			// topology. No state or background cron survives into the next tier.
			await stopApps()
			await resetState()

			const targetPort = await freePort()
			let instanceB
			if (project === 'cluster') {
				instanceB = await freePort()
				await startApp(targetPort)
				await startApp(instanceB)
			} else {
				await startApp(targetPort, project === 'stress' || project === 'destroyer')
			}

			const env = {
				...commonEnvironment(),
				BASE_URL: `http://127.0.0.1:${targetPort}`,
				...(instanceB ? { INSTANCE_B: `http://127.0.0.1:${instanceB}` } : {}),
				...(project === 'resilience' ? { LOCAL_E2E_RESILIENCE: '1' } : {}),
				// The named destroyer and complete commands are themselves the
				// explicit authorization. Direct run-e2e calls retain their guard.
				...(project === 'destroyer' ? { ALLOW_DESTRUCTIVE_E2E: '1' } : {})
			}
			const status = await runProject(project, env)
			results.push({ name: project, status, detail: status === 0 ? 'passed' : `exit ${status}` })
		} catch (error) {
			console.error(error)
			results.push({ name: project, status: 1, detail: error.message })
		}
	}
} catch (error) {
	console.error(error)
	results.push({ name: 'environment', status: 1, detail: error.message })
} finally {
	await cleanup()
}

console.log('\nLocal E2E tier summary')
for (const result of results) {
	console.log(`  ${result.status === 0 ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}`)
}
process.exitCode = results.length > 0 && results.every((result) => result.status === 0) ? 0 : 1

function projectsFor(name) {
	if (name === 'safe') return ['main', 'isolated']
	if (name === 'complete') return ['main', 'isolated', 'resilience', 'cluster', 'stress', 'destroyer']
	return [name]
}

function runProject(project, env) {
	// Forward optional Playwright selectors (for example --grep) from the
	// provisioned local harness. Resilience is always direct because it is
	// intentionally unreachable without the container names below.
	if (project === 'resilience' || playwrightArgs.length > 0) {
		const optional = ['cluster', 'resilience', 'stress', 'destroyer', 'diagnostics'].includes(project)
		return run(process.execPath, [
			'node_modules/@playwright/test/cli.js',
			'test',
			`--project=${project}`,
			...playwrightArgs
		], {
			...env,
			...(optional ? { E2E_OPTIONAL_PROJECT: project } : {}),
			...(project === 'destroyer' ? { RUN_DESTROYER: '1' } : {})
		})
	}
	return run(process.execPath, ['scripts/run-e2e.mjs', project], env)
}

function commonEnvironment() {
	return {
		...process.env,
		LOCAL_E2E: '1',
		DATABASE_URL: databaseURL,
		REDIS_URL: redisURL,
		TEST_POSTGRES_CONTAINER: postgresName,
		TEST_REDIS_CONTAINER: redisName,
		METRICS_SCRAPE_TOKEN: 'local-e2e-token',
		DEMO_NEWS_WEBHOOK_SECRET: 'local-e2e-webhook-secret'
	}
}

async function ensureProductionBuild() {
	await runChecked('production build', process.execPath, ['scripts/build.mjs'], {
		...process.env,
		DEMO_NEWS_WEBHOOK_SECRET: 'local-e2e-webhook-secret'
	})
}

async function provisionDependencies() {
	await runChecked('Docker availability', 'docker', ['info'], process.env, 'ignore')
	await runChecked('PostgreSQL container', 'docker', [
		'run', '--detach', '--name', postgresName,
		'--publish', `127.0.0.1:${postgresPort}:5432`,
		'--env', 'POSTGRES_PASSWORD=test', '--env', 'POSTGRES_DB=stickynotes',
		postgresImage
	], process.env)
	await runChecked('Redis container', 'docker', [
		'run', '--detach', '--name', redisName,
		'--publish', `127.0.0.1:${redisPort}:6379`,
		redisImage
	], process.env)

	await waitForStable('PostgreSQL', async () => (
		await run('docker', ['exec', postgresName, 'pg_isready', '-U', 'postgres', '-d', 'stickynotes'], process.env, 'ignore')
	) === 0)
	await waitFor('Redis', async () => (
		await run('docker', ['exec', redisName, 'redis-cli', 'ping'], process.env, 'ignore')
	) === 0)
}

async function resetState() {
	await runChecked('database reset', 'docker', [
		'exec', postgresName, 'psql', '-v', 'ON_ERROR_STOP=1',
		'-U', 'postgres', '-d', 'stickynotes', '-c',
		'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
	], process.env)
	await runChecked('Redis reset', 'docker', ['exec', redisName, 'redis-cli', 'FLUSHDB'], process.env)
	await runChecked('migrations', process.execPath, ['scripts/migrate.mjs'], commonEnvironment())
}

async function startApp(port, production = false) {
	const args = production
		? ['build/index.js']
		: ['node_modules/vite/bin/vite.js', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
	const child = spawn(process.execPath, args, {
		env: {
			...commonEnvironment(),
			HOST: '127.0.0.1',
			PORT: String(port),
			...(production ? {
				NODE_ENV: 'production',
				ORIGIN: `http://127.0.0.1:${port}`,
				CLUSTER_WORKERS: ''
			} : {})
		},
		stdio: 'inherit'
	})
	apps.push(child)
	await waitFor(`app:${port}`, async () => {
		if (child.exitCode !== null) throw new Error(`app:${port} exited with ${child.exitCode}`)
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
			return response.status < 500
		} catch {
			return false
		}
	}, 120_000)
}

async function waitFor(label, probe, timeout = 60_000) {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (await probe()) return
		await delay(500)
	}
	throw new Error(`${label} was not ready within ${timeout}ms`)
}

async function waitForStable(label, probe, timeout = 60_000, consecutive = 5) {
	const deadline = Date.now() + timeout
	let successes = 0
	while (Date.now() < deadline) {
		if (await probe()) {
			successes++
			if (successes >= consecutive) return
		} else {
			successes = 0
		}
		await delay(500)
	}
	throw new Error(`${label} was not stably ready within ${timeout}ms`)
}

async function cleanup() {
	if (cleaning) return
	cleaning = true
	await stopApps()
	await run('docker', ['rm', '--force', postgresName, redisName], process.env, 'ignore').catch(() => {})
}

async function stopApps() {
	const running = apps.splice(0)
	await Promise.all(running.map(stopApp))
}

async function stopApp(child) {
	if (child.exitCode !== null) return
	child.kill('SIGTERM')
	await Promise.race([
		new Promise((resolve) => child.once('exit', resolve)),
		delay(5000).then(() => child.kill('SIGKILL'))
	])
}

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {import('node:child_process').StdioOptions} [stdio]
 */
async function runChecked(label, command, args, env, stdio = 'inherit') {
	const status = await run(command, args, env, stdio)
	if (status !== 0) throw new Error(`${label} failed with exit ${status}`)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {import('node:child_process').StdioOptions} [stdio]
 */
function run(command, args, env, stdio = 'inherit') {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`${command} terminated by ${signal}`))
			else resolve(code ?? 1)
		})
	})
}

async function freePort() {
	for (;;) {
		const port = await new Promise((resolve, reject) => {
			const server = createServer()
			server.unref()
			server.once('error', reject)
			server.listen(0, '127.0.0.1', () => {
				const address = server.address()
				if (!address || typeof address === 'string') {
					server.close(() => reject(new Error('Could not allocate a TCP port')))
					return
				}
				server.close((error) => error ? reject(error) : resolve(address.port))
			})
		})
		if (!reservedPorts.has(port)) {
			reservedPorts.add(port)
			return port
		}
	}
}
