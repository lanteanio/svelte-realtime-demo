import { spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { selectOrphans } from './orphan-sweep.mjs'

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
// The build this run serves, owned by this run alone. Inside the repo rather
// than the OS temp dir on purpose: the built server imports bare specifiers
// (uWebSockets.js, svelte-realtime/server, the extensions entry points), so it
// only resolves from a directory that has this checkout's node_modules above
// it. `srd-build-<pid>-<timestamp>` matches the container naming, which is
// what lets the startup sweep reclaim one left by a killed run.
const BUILD_RUNS = 'build-runs'
const buildDir = `${BUILD_RUNS}/srd-build-${suffix}`
// Playwright's artifact staging, per run for the same reason the build is.
// Two runs sharing test-results/ share the .playwright-artifacts staging
// directory, and one run's cleanup deletes trace resources the other is still
// writing - which surfaces as ENOENT on a .css resource and a truncated zip at
// context.close(), on a test whose assertions all passed.
const TEST_RESULTS = 'test-results'
const outputDir = `${TEST_RESULTS}/srd-build-${suffix}`
// Windows holds a handle on a module file for a moment after the process that
// loaded it exits, so removing 700 of them straight after a SIGTERM can fail
// on a file that is about to be released. Retrying is the difference between
// reclaiming the tree now and leaving it for the next run's startup sweep.
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }
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
	// Every tier runs the production build, not `vite dev`.
	//
	// The dev server transforms and serves the module graph on demand, and a
	// page load can intermittently fail to hydrate: the SSR HTML renders, Vite's
	// own HMR socket connects, and the app bundle never boots. The page is then
	// wedged with no app socket, no pending retry, and a connection status still
	// on its initial value, so it never recovers at any timeout. Measured at
	// roughly one open in 900 while cycling routes, and zero in 80 opens of a
	// single warm route, which is why re-running a victim in isolation always
	// "passed" and cleared code that was never at fault.
	//
	// That put a false-failure rate on the merge gate, which is worse than the
	// one dead test: it trains readers to wave through a single failure as the
	// flake, and that is how a real regression gets merged. A pre-built bundle
	// cannot fail this way, and it has the larger benefit of making the gate
	// test the artifact that actually ships.
	//
	// Into this run's own directory, and served from there for the whole tier.
	// The containers have been per-run for a while; the build was the half
	// still shared, which is why a second session's rebuild could void a live
	// run with nothing in its output to say so.
	await sweepOrphanedBuilds()
	await ensureProductionBuild()
	await provisionDependencies()

	for (const project of selectedProjects) {
		try {
			// Every tier gets a clean database, Redis keyspace, and process
			// topology. No state or background cron survives into the next tier.
			await stopApps()
			await resetState()

			const targetPort = await freePort()
			let instanceB
			await startApp(targetPort)
			if (project === 'cluster') {
				instanceB = await freePort()
				await startApp(instanceB)
			}

			await waitForCronWarmup()

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
		PLAYWRIGHT_OUTPUT_DIR: outputDir,
		DATABASE_URL: databaseURL,
		REDIS_URL: redisURL,
		TEST_POSTGRES_CONTAINER: postgresName,
		TEST_REDIS_CONTAINER: redisName,
		METRICS_SCRAPE_TOKEN: 'local-e2e-token',
		DEMO_NEWS_WEBHOOK_SECRET: 'local-e2e-webhook-secret',
		// The demo purge crons trim user-appended content on a wall-clock
		// schedule; a tick landing mid-tier would delete rows a running spec
		// just created. No spec exercises the cron itself, so disable both.
		DEMO_PURGE_INTERVAL_MIN: '0',
		DEMO_UPLOAD_PURGE_INTERVAL_MIN: '0'
	}
}

async function ensureProductionBuild() {
	await runChecked('production build', process.execPath, ['scripts/build.mjs'], {
		...process.env,
		DEMO_NEWS_WEBHOOK_SECRET: 'local-e2e-webhook-secret',
		BUILD_OUT_DIR: buildDir
	})
}

async function provisionDependencies() {
	await runChecked('Docker availability', 'docker', ['info'], process.env, 'ignore')
	await sweepOrphanedContainers()
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

async function startApp(port) {
	// Production build only, out of this run's own directory. The dev-server
	// path this used to take is what made the gate flaky; see the
	// ensureProductionBuild call above for the mechanism. Debugging against
	// `vite dev` is still available by running `npm run dev` and pointing
	// playwright at it through BASE_URL, which keeps that option without
	// letting the gate reach for it by accident.
	const child = spawn(process.execPath, [`${buildDir}/index.js`], {
		env: {
			...commonEnvironment(),
			HOST: '127.0.0.1',
			PORT: String(port),
			NODE_ENV: 'production',
			ORIGIN: `http://127.0.0.1:${port}`,
			CLUSTER_WORKERS: ''
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

/**
 * The from-seq demo renders rows only after its leader-elected 1Hz cron has
 * written events into the freshly flushed Redis keyspace, and leadership can
 * take several seconds to settle after boot. A spec that opens that page
 * right away would stare at an empty durable store for its whole readiness
 * budget. Gate each tier on the first two ticks instead of making every spec
 * pad its own timeout for a one-time boot race.
 */
async function waitForCronWarmup() {
	await waitFor('from-seq cron warmup', async () => {
		const output = await capture('docker', ['exec', redisName, 'redis-cli', 'GET', 'demos:fromseq:next'])
		return Number(output.trim()) >= 2
	}, 90_000)
}

function capture(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
		let out = ''
		child.stdout.on('data', (chunk) => { out += chunk })
		child.once('error', reject)
		child.once('exit', () => resolve(out))
	})
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
	// --volumes so the container's anonymous volume goes with it. Without it
	// every run left one behind invisibly; they had reached 677 volumes and
	// about 16GB of reclaimable space before anyone looked.
	await run('docker', ['rm', '--force', '--volumes', postgresName, redisName], process.env, 'ignore').catch(() => {})
	// After stopApps, so nothing is still reading out of it. A failure here is
	// reported and not fatal: the run's result is already decided, and the
	// startup sweep reclaims what is left either way.
	await rm(buildDir, REMOVE_TREE)
		.catch((error) => console.error(`could not remove ${buildDir}: ${error.message}`))
	// The artifacts are the run's evidence on a failure, so they are kept when
	// anything failed and swept on a clean run; the startup sweep reclaims what
	// a killed run leaves either way.
	if (results.every((result) => result.status === 0)) {
		await rm(outputDir, REMOVE_TREE)
			.catch((error) => console.error(`could not remove ${outputDir}: ${error.message}`))
	}
}

/**
 * Remove containers left behind by harness runs that died without cleanup().
 *
 * cleanup() covers normal exit and SIGINT/SIGTERM, but a harder kill skips it
 * and nothing else ever reclaimed the result: containers were found still
 * running 29 hours later, and a machine carrying several runs' worth of idle
 * Postgres and Redis is a plausible source of trouble in a suite whose
 * assertions are this timing-sensitive. Sweeping at STARTUP is the only
 * placement that survives a kill; any teardown-side fix has the same hole the
 * current one does.
 *
 * Ownership needs no new bookkeeping because the container name already
 * carries the creating PID. A container whose PID is gone cannot have a live
 * owner. A PID recycled by an unrelated process reads as alive and its
 * container is left alone, so the failure mode is leaving a leak in place
 * rather than deleting a running harness's database - concurrent runs are
 * legitimate here, which is why this cannot simply remove everything that is
 * not ours.
 */
async function sweepOrphanedContainers() {
	let listed = ''
	try {
		listed = await capture('docker', ['ps', '--all', '--filter', 'name=srd-test-', '--format', '{{.Names}}'])
	} catch {
		return
	}
	const orphans = selectOrphans(listed.split(/\r?\n/))
	if (!orphans.length) return
	console.log(`orphaned containers: removing ${orphans.length} left by dead harness runs`)
	await run('docker', ['rm', '--force', '--volumes', ...orphans], process.env, 'ignore').catch(() => {})
}

/**
 * Remove per-run build directories left behind by runs that died without
 * cleanup(). Same ownership rule and the same startup placement as the
 * containers above, for the same reason: a teardown-side fix has the hole that
 * a hard kill skips it, and each of these is about 8 MB across 700 files.
 */
async function sweepOrphanedBuilds() {
	for (const root of [BUILD_RUNS, TEST_RESULTS]) {
		let listed
		try {
			listed = await readdir(root)
		} catch {
			continue
		}
		const orphans = selectOrphans(listed)
		if (!orphans.length) continue
		console.log(`orphaned run directories: removing ${orphans.length} from ${root}, left by dead harness runs`)
		for (const orphan of orphans) {
			await rm(`${root}/${orphan}`, REMOVE_TREE)
				.catch((error) => console.error(`could not remove ${orphan}: ${error.message}`))
		}
	}
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
