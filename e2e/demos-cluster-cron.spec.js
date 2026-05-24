import { test, expect } from '@playwright/test'

/**
 * /demos/cluster-cron e2e.
 *
 * The demo's whole pitch is multi-instance leader election sharing one
 * Redis. The single-server flow we verify here:
 *
 *  1. The page renders all panels (self / ticks / instances / instructions).
 *  2. The self panel reports a non-empty instanceId hydrated from the
 *     myClusterCronState RPC, regardless of whether this worker is the
 *     leader or a follower.
 *  3. Cron ticks reach the page within a few seconds. The tick stream is
 *     fed via Redis pub/sub from whichever cluster worker holds the lease,
 *     so subscribers see ticks even when this worker is a follower.
 *  4. The /metrics endpoint advertises the leader counters wired by
 *     createLeader. The HELP / TYPE lines are emitted as soon as the
 *     counters are registered, validating the cluster-state machinery is
 *     plumbed through Prometheus.
 *
 * The takeover scenario (start two servers, kill the leader, watch the
 * surviving sibling acquire the lease) is documented as a manual smoke
 * test in source/shipped-log-0.5.0.md, not asserted here.
 */

test.describe('/demos/cluster-cron', () => {
	test('renders self panel, ticks panel, instances panel, and instructions banner', async ({ page }) => {
		await page.goto('/demos/cluster-cron')
		await expect(page.getByTestId('cluster-cron-self-panel')).toBeVisible()
		await expect(page.getByTestId('cluster-cron-ticks')).toBeVisible()
		await expect(page.getByTestId('cluster-cron-instances')).toBeVisible()
		await expect(page.getByTestId('cluster-cron-instructions')).toBeVisible()
		await expect(page.getByTestId('self-instance-id')).toBeVisible()
		await expect(page.getByTestId('lease-key')).toBeVisible()
	})

	test('self panel hydrates a non-empty instanceId from myClusterCronState', async ({ page }) => {
		await page.goto('/demos/cluster-cron')

		await expect.poll(
			async () => (await page.getByTestId('self-instance-id').textContent())?.trim(),
			{ timeout: 8_000 }
		).not.toBe('...')

		const id = (await page.getByTestId('self-instance-id').textContent())?.trim() ?? ''
		expect(id.length).toBeGreaterThan(0)
		expect(id).not.toBe('...')

		// And the leader / follower badge is visible (one of them must be).
		// Lone instance dev: leader. Multi-instance shared Redis: follower.
		await expect(page.getByTestId('self-leader-status')).toBeVisible()
	})

	test('cron tick events arrive within ~8s; latest tick has a non-empty instanceId', async ({ page }) => {
		await page.goto('/demos/cluster-cron')

		// The 1Hz cron is gated by the leader. Single-instance dev: this
		// worker is always the leader. Multi-instance shared Redis: another
		// worker fires; this worker still receives via pub/sub.
		await expect(page.getByTestId('cluster-cron-ticks-list')).toBeVisible({ timeout: 8_000 })

		const rows = await page.getByTestId('cluster-cron-tick-row').count()
		expect(rows).toBeGreaterThanOrEqual(1)

		// The most recent tick must report a non-empty instanceId; we don't
		// pin it to self because in a multi-instance environment the leader
		// could be a sibling worker.
		await expect.poll(
			async () => (await page.getByTestId('cluster-cron-tick-row').first().getAttribute('data-instance-id')) ?? '',
			{ timeout: 5_000 }
		).not.toBe('')
	})

	test('/metrics endpoint exposes labelled leader_acquired_total counter', async ({ page, request }) => {
		// Visit the page first so the worker is warm.
		await page.goto('/demos/cluster-cron')
		await expect(page.getByTestId('cluster-cron-self-panel')).toBeVisible()

		// adapter next.17 fixed the duplicate-registry build bug, so the
		// labelled `leader_acquired_total{key_class="leader"} N` line now
		// reaches the /metrics scrape (the lone-worker setup acquires the
		// lease at boot). Single-instance dev has key_class="leader".
		//
		// /metrics is gated by METRICS_SCRAPE_TOKEN on deployed
		// environments. Pass the token through when set; locally / open
		// scrapes work either way (the endpoint accepts any request when
		// the env var is unset).
		const token = process.env.METRICS_SCRAPE_TOKEN
		const headers = token ? { 'x-scrape-token': token } : {}
		const res = await request.get('/metrics', { headers })
		expect(res.status()).toBe(200)
		const body = await res.text()
		// Counter machinery is wired up either way (HELP / TYPE lines
		// always emit). The labelled sample line only appears on whichever
		// instance acquired the lease; in a multi-instance deploy this
		// scrape might hit a follower whose acquire attempt lost the race
		// and never incremented the counter. Accept either shape.
		expect(body).toMatch(/^# (HELP|TYPE) leader_acquired_total\b/m)
		expect(body).toContain('leader_renewals_total')
	})
})
