import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
import { createBoard, createNote, getNotes, waitForBoardReady, waitForWS } from './helpers.js'

const execFileAsync = promisify(execFile)
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const harness = assertLocalHarness()

test.describe.serial('Local dependency resilience', () => {
	test.afterEach(async ({ request }) => {
		// Never leave the next test (or the provisioner's cleanup) with a stopped
		// dependency, even if an assertion failed in the middle of an outage.
		await startContainer(harness.postgresContainer)
		await startContainer(harness.redisContainer)
		await waitForOverallReadiness(request, 'ok')
	})

	test('PostgreSQL outage keeps the app alive and retries a buffered note move', async ({ page, request }) => {
		await waitForOverallReadiness(request, 'ok')

		const boardPath = await createBoard(page, `resilience-db-${Date.now()}`)
		// Vite may finish first-use dependency optimization immediately after
		// the create RPC's client-side navigation. Navigate explicitly so any
		// optimizer reload is anchored to the board URL, then require the board
		// canvas rather than accepting the home page's generic h1.
		await page.goto(boardPath)
		await waitForBoardReady(page)
		await expect(page.locator('div.relative.w-full.overflow-auto')).toBeVisible({ timeout: 30_000 })
		await waitForWS(page)
		await createNote(page, 250, 220)
		await expect(getNotes(page).first()).toBeVisible()

		// Prime the per-note move cache, then prove that position is durable before
		// taking PostgreSQL away. The outage move can therefore use the hot path.
		const primedPosition = await dragNote(page, 40, 30)
		const slug = boardPath.split('/').filter(Boolean).at(-1)
		await waitForDurablePosition(slug, primedPosition)

		let stopped = false
		let outagePosition
		try {
			// The move cache evicts a clean entry after 10s idle. Refresh it right
			// before the outage so that idle timer cannot expire during the stop and
			// (unbounded) down-status polling and force the outage move onto the
			// cold, Postgres-dependent ownership path.
			const rewarmPosition = await dragNote(page, 20, 15)
			await waitForDurablePosition(slug, rewarmPosition)

			await stopContainer(harness.postgresContainer)
			stopped = true

			// Issue the buffered move while the cache entry is still warm, before the
			// slow readiness polling below can age it past the eviction TTL.
			outagePosition = await dragNote(page, 120, 80)
			expect(outagePosition).not.toEqual(rewarmPosition)

			await waitForDependencyStatus(request, 'postgres', 'down')

			const health = await readHealth(request)
			expect(health.httpStatus).toBe(503)
			expect(health.status).toBe('not-ready')

			// Let at least one bounded database attempt fail. The dirty generation
			// must remain queued for a later flush rather than being acknowledged.
			await page.waitForTimeout(3000)
		} finally {
			if (stopped) await startContainer(harness.postgresContainer)
		}

		await waitForDependencyStatus(request, 'postgres', 'ok')
		await waitForOverallReadiness(request, 'ok')
		await waitForDurablePosition(slug, outagePosition)

		await page.reload()
		await waitForBoardReady(page)
		await expect.poll(
			async () => positionKey(await notePosition(getNotes(page).first())),
			{ timeout: 15_000, intervals: [250, 500, 1000] }
		).toBe(positionKey(outagePosition))
	})

	test('Redis outage bounds ordinary HTTP and realtime recovers after restart', async ({ page, request }) => {
		await page.goto('/')
		await waitForWS(page)
		await waitForOverallReadiness(request, 'ok')

		let stopped = false
		try {
			await stopContainer(harness.redisContainer)
			stopped = true
			await waitForDependencyStatus(request, 'redis', 'down')

			const health = await readHealth(request)
			expect(health.httpStatus).toBe(503)
			expect(health.status).toBe('not-ready')

			const started = performance.now()
			const response = await request.get('/', {
				failOnStatusCode: false,
				timeout: 5000
			})
			const elapsedMs = performance.now() - started
			expect(response.status()).toBeLessThan(500)
			expect(elapsedMs).toBeLessThan(5000)
		} finally {
			if (stopped) await startContainer(harness.redisContainer)
		}

		await waitForDependencyStatus(request, 'redis', 'ok')
		await waitForOverallReadiness(request, 'ok')

		// A fresh websocket and RPC after recovery exercises more than Redis PING:
		// the realtime registry/subscriber must be usable again as well.
		const boardPath = await createBoard(page, `resilience-redis-${Date.now()}`)
		expect(boardPath).toMatch(/^\/board\//)
		await waitForWS(page)
	})
})

function assertLocalHarness() {
	if (process.env.LOCAL_E2E_RESILIENCE !== '1') {
		throw new Error('Resilience tests require the local E2E provisioner')
	}

	const baseURL = requireLoopbackURL('BASE_URL')
	const databaseURL = requireLoopbackURL('DATABASE_URL')
	requireLoopbackURL('REDIS_URL')

	const postgresContainer = requireContainerName('TEST_POSTGRES_CONTAINER', 'postgres')
	const redisContainer = requireContainerName('TEST_REDIS_CONTAINER', 'redis')
	const postgresSuffix = postgresContainer.slice('srd-test-postgres-'.length)
	const redisSuffix = redisContainer.slice('srd-test-redis-'.length)
	if (postgresSuffix !== redisSuffix) {
		throw new Error('Resilience containers must belong to the same local provisioner run')
	}

	return { baseURL, databaseURL, postgresContainer, redisContainer }
}

function requireLoopbackURL(name) {
	const raw = process.env[name]
	if (!raw) throw new Error(`${name} is required for local resilience tests`)
	const url = new URL(raw)
	if (!LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error(`${name} must target loopback, got ${url.origin}`)
	}
	return url
}

function requireContainerName(name, dependency) {
	const value = process.env[name]
	const pattern = new RegExp(`^srd-test-${dependency}-[0-9]+-[0-9]+$`)
	if (!value || !pattern.test(value)) {
		throw new Error(`${name} is not a provisioned local ${dependency} container`)
	}
	return value
}

async function docker(args) {
	return execFileAsync('docker', args, {
		encoding: 'utf8',
		timeout: 30_000,
		windowsHide: true
	})
}

async function stopContainer(name) {
	await docker(['stop', '--timeout', '1', name])
}

async function startContainer(name) {
	await docker(['start', name])
}

async function readHealth(request) {
	const response = await request.get('/healthz', {
		failOnStatusCode: false,
		timeout: 7500
	})
	let body = {}
	try {
		body = await response.json()
	} catch {
		// The caller's assertion will report the unexpected shape/status.
	}
	return { httpStatus: response.status(), ...body }
}

async function waitForDependencyStatus(request, dependency, expected) {
	const timeout = expected === 'ok' ? 90_000 : 30_000
	await expect.poll(async () => {
		try {
			const health = await readHealth(request)
			return health.checks?.[dependency]?.status ?? 'missing'
		} catch {
			return 'request-failed'
		}
	}, {
		message: `${dependency} readiness should become ${expected}`,
		timeout,
		intervals: [250, 500, 1000]
	}).toBe(expected)
}

async function waitForOverallReadiness(request, expected) {
	const timeout = expected === 'ok' ? 90_000 : 30_000
	await expect.poll(async () => {
		try {
			return (await readHealth(request)).status ?? 'missing'
		} catch {
			return 'request-failed'
		}
	}, {
		message: `application readiness should become ${expected}`,
		timeout,
		intervals: [250, 500, 1000]
	}).toBe(expected)
}

async function dragNote(page, dx, dy) {
	const note = getNotes(page).first()
	const box = await note.boundingBox()
	if (!box) throw new Error('Cannot drag a note without a bounding box')
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.down()
	await page.mouse.move(
		box.x + box.width / 2 + dx,
		box.y + box.height / 2 + dy,
		{ steps: 8 }
	)
	await page.mouse.up()
	await page.waitForTimeout(750)
	return notePosition(note)
}

async function notePosition(note) {
	return note.evaluate((element) => ({
		x: Number.parseInt(element.style.left, 10),
		y: Number.parseInt(element.style.top, 10)
	}))
}

function positionKey(position) {
	return `${position.x},${position.y}`
}

async function readDurablePosition(slug) {
	const client = new pg.Client({
		connectionString: harness.databaseURL.href,
		connectionTimeoutMillis: 2000,
		query_timeout: 2000
	})
	try {
		await client.connect()
		const result = await client.query(`
			SELECT n.x, n.y
			  FROM note AS n
			  JOIN board AS b ON b.board_id = n.board_id
			 WHERE b.slug = $1
		  ORDER BY n.created_at
			 LIMIT 1
		`, [slug])
		return result.rows[0] ?? null
	} finally {
		await client.end().catch(() => {})
	}
}

async function waitForDurablePosition(slug, expected) {
	await expect.poll(async () => {
		try {
			const position = await readDurablePosition(slug)
			return position ? positionKey(position) : 'missing'
		} catch {
			return 'unavailable'
		}
	}, {
		message: `note position should become durable at ${positionKey(expected)}`,
		timeout: 30_000,
		intervals: [250, 500, 1000]
	}).toBe(positionKey(expected))
}
