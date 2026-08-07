import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const execFileAsync = promisify(execFile)

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')
const DISTINCT_TARGETS = new URL(INSTANCE_A).origin !== new URL(INSTANCE_B).origin
const REMOTE_TARGET = !['localhost', '127.0.0.1', '[::1]'].includes(new URL(INSTANCE_A).hostname)
const TICK_CAP = 30

test.skip(!process.env.INSTANCE_B, 'cluster-cron coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/cluster-cron`)
	await waitForWS(page)
	await expect.poll(
		async () => (await page.getByTestId('self-instance-id').textContent())?.trim(),
		{ timeout: 12_000 }
	).toMatch(/^[0-9a-f]{16}$/)
	await expect(page.getByTestId('cluster-cron-tick-row').first()).toBeVisible({ timeout: 12_000 })
}

async function selfId(page) {
	return (await page.getByTestId('self-instance-id').textContent())?.trim() ?? ''
}

async function latestLeader(page) {
	return await page.getByTestId('cluster-cron-tick-row').first().getAttribute('data-instance-id') ?? ''
}

async function tickSeqs(page) {
	return page.getByTestId('tick-seq').allTextContents().then((values) => (
		values.map((value) => Number(value.replace('#', '').trim()))
	))
}

async function latestSeq(page) {
	return (await tickSeqs(page))[0] ?? 0
}

async function waitForConvergence(a, b) {
	await expect.poll(async () => {
		const [leaderA, leaderB, seqA, seqB] = await Promise.all([
			latestLeader(a), latestLeader(b), latestSeq(a), latestSeq(b)
		])
		return leaderA === leaderB && Math.abs(seqA - seqB) <= 1
	}, { timeout: 15_000 }).toBe(true)
}

// Expiring the lease is the only way to produce a takeover without killing a
// process, and it has to happen in Redis because the lease is server-side
// state - dropping a client socket changes nothing about who holds it. Bound
// this to the provisioned local container, exactly as the resilience tier
// does, so it can never point at a shared or deployed Redis.
const REDIS_CONTAINER = process.env.TEST_REDIS_CONTAINER ?? ''
const LOCAL_PROVISIONER = /^srd-test-redis-[0-9]+-[0-9]+$/.test(REDIS_CONTAINER)

async function redisCli(...args) {
	const { stdout } = await execFileAsync('docker', ['exec', REDIS_CONTAINER, 'redis-cli', ...args], {
		encoding: 'utf8',
		timeout: 30_000,
		windowsHide: true
	})
	return stdout.trim()
}

async function statusOf(page) {
	return (await page.getByTestId('self-leader-status').textContent())?.trim() ?? ''
}

async function pollUntil(predicate, timeoutMs, intervalMs = 500) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await predicate()) return true
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
	return false
}

function expectContinuousNewestFirst(seqs) {
	expect(new Set(seqs).size).toBe(seqs.length)
	for (let index = 1; index < seqs.length; index++) {
		expect(seqs[index - 1] - seqs[index]).toBe(1)
	}
}

function metricSum(body, name, labels = () => true) {
	let total = 0
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith(name)) continue
		const match = line.match(new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`))
		if (match && labels(match[1] ?? '')) total += Number(match[2])
	}
	return total
}

async function scrape(request, origin) {
	const token = process.env.METRICS_SCRAPE_TOKEN
	const response = await request.get(`${origin}/metrics`, {
		headers: token ? { 'x-scrape-token': token } : {}
	})
	return { status: response.status(), body: await response.text() }
}

test.describe('cluster: /demos/cluster-cron', () => {
	test('replicas converge on one leader while retaining distinct self identities', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await waitForConvergence(a, b)

			const [idA, idB, leaderA, leaderB] = await Promise.all([
				selfId(a), selfId(b), latestLeader(a), latestLeader(b)
			])
			if (DISTINCT_TARGETS) expect(idA).not.toBe(idB)
			expect(leaderB).toBe(leaderA)
			if (DISTINCT_TARGETS) expect([idA, idB]).toContain(leaderA)
			await expect(a.getByTestId('current-leader-id')).toHaveText(`${leaderA.slice(0, 8)}...`)
			await expect(b.getByTestId('current-leader-id')).toHaveText(`${leaderA.slice(0, 8)}...`)
			await expect(a.getByTestId('instance-leader-badge')).toHaveCount(1)
			await expect(b.getByTestId('instance-leader-badge')).toHaveCount(1)

			if (DISTINCT_TARGETS) {
				const statuses = await Promise.all([
					a.getByTestId('self-leader-status').textContent(),
					b.getByTestId('self-leader-status').textContent()
				])
				expect(statuses.filter((status) => status?.trim() === 'leader')).toHaveLength(1)
				const follower = leaderA === idA ? b : a
				await expect(follower.getByTestId('cluster-cron-instance-row')).toHaveCount(2)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('global sequence advances at one cron per second and fans out continuously to both replicas', async ({ browser }) => {
		test.setTimeout(65_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await waitForConvergence(a, b)
			const start = await latestSeq(a)
			const windowMs = 8_000
			await a.waitForTimeout(windowMs)
			const end = await latestSeq(a)
			const delta = end - start
			expect(delta, `cluster cron advanced ${delta} ticks in ${windowMs}ms`).toBeGreaterThanOrEqual(6)
			expect(delta, `cluster cron advanced ${delta} ticks in ${windowMs}ms`).toBeLessThanOrEqual(12)
			await waitForConvergence(a, b)
			expectContinuousNewestFirst(await tickSeqs(a))
			expectContinuousNewestFirst(await tickSeqs(b))

			const rowsA = a.getByTestId('cluster-cron-tick-row')
			const rowsB = b.getByTestId('cluster-cron-tick-row')
			await Promise.all([
				expect(rowsA).toHaveCount(TICK_CAP, { timeout: 40_000 }),
				expect(rowsB).toHaveCount(TICK_CAP, { timeout: 40_000 })
			])
			await a.waitForTimeout(2_200)
			await expect(rowsA).toHaveCount(TICK_CAP)
			await expect(rowsB).toHaveCount(TICK_CAP)
			expectContinuousNewestFirst(await tickSeqs(a))
			expectContinuousNewestFirst(await tickSeqs(b))
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('a leader change after mount moves the badge on both replicas', async ({ browser }) => {
		test.skip(!LOCAL_PROVISIONER, 'forcing a re-election needs the provisioned local Redis')
		test.skip(!DISTINCT_TARGETS, 'a takeover needs two distinct replicas')
		test.setTimeout(200_000)

		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await waitForConvergence(a, b)

			const [idA, idB] = await Promise.all([selfId(a), selfId(b)])
			expect(idA).not.toBe(idB)
			const leaderBefore = await latestLeader(a)
			expect([idA, idB]).toContain(leaderBefore)

			// Both pages have been mounted and have answered once. Whatever the
			// badge says from here on is a post-mount claim.
			const before = await Promise.all([statusOf(a), statusOf(b)])
			expect(before.filter((status) => status === 'leader')).toHaveLength(1)

			const leaseKey = (await a.getByTestId('lease-key').textContent())?.trim().replace(/^'|'$/g, '') ?? ''
			expect(leaseKey).not.toBe('')
			// The page publishes the key; confirm it names the lease this cluster
			// is actually holding before deleting anything. A wrong key would
			// otherwise delete nothing and leave the takeover below looking
			// merely slow.
			expect(await redisCli('GET', leaseKey), 'lease-key does not name the live lease').toBe(leaderBefore)

			// Deleting the lease makes the holder's next renew fail, which only
			// clears its flag - it cannot re-acquire until the tick after that.
			// The follower needs one tick, so the takeover usually lands on the
			// first delete; retry because which timer fires first is a race.
			let leaderAfter = leaderBefore
			for (let attempt = 1; attempt <= 5 && leaderAfter === leaderBefore; attempt++) {
				await redisCli('DEL', leaseKey)
				await pollUntil(async () => (await latestLeader(a)) !== leaderBefore, 25_000)
				leaderAfter = await latestLeader(a)
			}
			expect(leaderAfter, 'no replica took the lease over after five expiries').not.toBe(leaderBefore)
			expect([idA, idB]).toContain(leaderAfter)

			await waitForConvergence(a, b)

			// The assertion this test exists for. A mount-time snapshot keeps
			// both pages on their boot answer forever, so the page that was
			// elected at mount would still claim the lease it just lost.
			const demoted = leaderBefore === idA ? a : b
			const promoted = leaderBefore === idA ? b : a
			await expect(demoted.getByTestId('self-leader-status')).toHaveText('follower', { timeout: 15_000 })
			await expect(promoted.getByTestId('self-leader-status')).toHaveText('leader', { timeout: 15_000 })

			// The rest of the panel has to agree, on both replicas.
			for (const page of [a, b]) {
				await expect(page.getByTestId('current-leader-id')).toHaveText(`${leaderAfter.slice(0, 8)}...`)
				await expect(page.getByTestId('instance-leader-badge')).toHaveCount(1)
			}
			await expect(promoted.getByTestId('current-leader-self')).toBeVisible()
			await expect(demoted.getByTestId('current-leader-self')).toHaveCount(0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('per-replica metrics prove one successful cron and follower skips', async ({ request }) => {
		const [scrapeA, scrapeB] = await Promise.all([
			scrape(request, INSTANCE_A),
			scrape(request, INSTANCE_B)
		])
		if (REMOTE_TARGET && [scrapeA.status, scrapeB.status].includes(401)) {
			test.skip(true, 'remote per-replica metrics require the deployment-specific METRICS_SCRAPE_TOKEN')
		}
		expect(scrapeA.status).toBe(200)
		expect(scrapeB.status).toBe(200)
		const bodyA = scrapeA.body
		const bodyB = scrapeB.body
		for (const body of [bodyA, bodyB]) {
			expect(body).toMatch(/^# (HELP|TYPE) leader_acquired_total\b/m)
			expect(body).toMatch(/^# (HELP|TYPE) leader_renewals_total\b/m)
			expect(body).toMatch(/^# (HELP|TYPE) svelte_realtime_cron_total\b/m)
		}
		expect(metricSum(bodyA, 'leader_acquired_total') + metricSum(bodyB, 'leader_acquired_total')).toBeGreaterThan(0)
		expect(
			metricSum(bodyA, 'svelte_realtime_cron_total', (labels) => labels.includes('status="ok"')) +
			metricSum(bodyB, 'svelte_realtime_cron_total', (labels) => labels.includes('status="ok"'))
		).toBeGreaterThan(0)
		if (DISTINCT_TARGETS) {
			expect(
				metricSum(bodyA, 'svelte_realtime_cron_total', (labels) => labels.includes('status="not-leader"')) +
				metricSum(bodyB, 'svelte_realtime_cron_total', (labels) => labels.includes('status="not-leader"'))
			).toBeGreaterThan(0)
		}
	})
})
