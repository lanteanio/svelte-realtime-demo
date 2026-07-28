import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

const TICK_CAP = 30
const TARGET_HOST = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000').hostname
const REMOTE_TARGET = !['localhost', '127.0.0.1', '[::1]'].includes(TARGET_HOST)

async function openClusterCron(page) {
	await page.goto('/demos/cluster-cron')
	await waitForWS(page)
	await expect.poll(
		async () => (await page.getByTestId('self-instance-id').textContent())?.trim(),
		{ timeout: 10_000 }
	).toMatch(/^[0-9a-f]{16}$/)
}

async function tickSeqs(page) {
	return page.getByTestId('tick-seq').allTextContents().then((values) => (
		values.map((value) => Number(value.replace('#', '').trim()))
	))
}

function expectContinuousNewestFirst(seqs) {
	expect(seqs.length).toBeGreaterThan(0)
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

async function scrapeMetrics(request) {
	const token = process.env.METRICS_SCRAPE_TOKEN
	const response = await request.get('/metrics', {
		headers: token ? { 'x-scrape-token': token } : {}
	})
	return {
		status: response.status(),
		contentType: response.headers()['content-type'] ?? '',
		body: await response.text()
	}
}

test.describe('/demos/cluster-cron', () => {
	test('renders and hydrates every observability panel with real leader metadata', async ({ page }) => {
		await openClusterCron(page)

		await expect(page.getByRole('heading', { name: 'Cluster cron: one leader, one tick' })).toBeVisible()
		for (const id of [
			'cluster-cron-self-panel',
			'cluster-cron-ticks',
			'cluster-cron-instances',
			'cluster-cron-instructions'
		]) {
			await expect(page.getByTestId(id)).toBeVisible()
		}

		await expect(page.getByTestId('lease-key')).not.toHaveText('...')
		await expect(page.getByTestId('lease-key')).toContainText('leader')
		await expect(page.getByTestId('self-leader-status')).toHaveText(/leader|follower/)
		await expect(page.getByText(`cap ${TICK_CAP}`, { exact: true })).toBeVisible()
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_acquired_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_renewals_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_lost_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('svelte_realtime_cron_total')
	})

	test('tick log, current leader, and instance roster agree on real newest-first data', async ({ page }) => {
		await openClusterCron(page)
		await expect(page.getByTestId('cluster-cron-tick-row').nth(2)).toBeVisible({ timeout: 10_000 })

		const rows = page.getByTestId('cluster-cron-tick-row')
		const latestLeader = await rows.first().getAttribute('data-instance-id')
		expect(latestLeader).toMatch(/^[0-9a-f]{16}$/)
		await expect(page.getByTestId('current-leader-id')).toHaveText(`${latestLeader.slice(0, 8)}...`)
		await expect(page.getByTestId('tick-time').first()).not.toHaveText('')
		await expect(page.getByTestId('tick-instance-id').first()).toHaveText(`${latestLeader.slice(0, 8)}...`)

		expectContinuousNewestFirst(await tickSeqs(page))
		await expect(page.getByTestId('instance-leader-badge')).toHaveCount(1)
		expect(await page.getByTestId('cluster-cron-instance-row').count()).toBeGreaterThanOrEqual(1)
	})

	test('the only page drill-down navigates to durable jobs and back to a live ticking view', async ({ page }) => {
		await openClusterCron(page)
		const before = (await tickSeqs(page))[0] ?? 0

		await page.getByRole('link', { name: '/demos/jobs', exact: true }).click()
		await expect(page).toHaveURL(/\/demos\/jobs$/)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

		await page.goBack()
		await expect(page).toHaveURL(/\/demos\/cluster-cron$/)
		await waitForWS(page)
		await expect.poll(async () => (await tickSeqs(page))[0] ?? 0, { timeout: 10_000 }).toBeGreaterThan(before)
	})

	test('/metrics exposes registered leader and cron families with live samples', async ({ page, request }) => {
		await openClusterCron(page)

		const initial = await scrapeMetrics(request)
		if (initial.status === 401 && REMOTE_TARGET) {
			test.skip(true, 'remote metrics require the deployment-specific METRICS_SCRAPE_TOKEN')
		}
		expect(initial.status).toBe(200)
		expect(initial.contentType).toContain('text/plain')
		let body = initial.body
		await expect.poll(async () => {
			const scrape = await scrapeMetrics(request)
			expect(scrape.status).toBe(200)
			body = scrape.body
			return metricSum(body, 'svelte_realtime_cron_total', (labels) => labels.includes('status="ok"'))
		}, { timeout: 15_000 }).toBeGreaterThan(0)

		for (const metric of [
			'leader_acquired_total',
			'leader_renewals_total',
			'leader_lost_total',
			'leader_renewal_failures_total',
			'svelte_realtime_cron_total'
		]) {
			expect(body).toMatch(new RegExp(`^# (HELP|TYPE) ${metric}\\b`, 'm'))
		}
		expect(metricSum(body, 'leader_acquired_total')).toBeGreaterThan(0)
	})

	test('recent history reaches and stays at the hard 30-row cap with continuous unique sequences', async ({ page }) => {
		test.setTimeout(55_000)
		await openClusterCron(page)
		const rows = page.getByTestId('cluster-cron-tick-row')
		await expect(rows).toHaveCount(TICK_CAP, { timeout: 40_000 })
		expectContinuousNewestFirst(await tickSeqs(page))
		const newestBefore = (await tickSeqs(page))[0]

		await page.waitForTimeout(3_200)
		await expect(rows).toHaveCount(TICK_CAP)
		const after = await tickSeqs(page)
		expectContinuousNewestFirst(after)
		expect(after[0]).toBeGreaterThanOrEqual(newestBefore + 2)
	})
})
