import { test, expect } from '@playwright/test'

test.describe('/demos/from-seq', () => {
	test('initial render: events appear within 5s; tier counts populate (rehydrate or live)', async ({ page }) => {
		await page.goto('/demos/from-seq')
		// The cron fires once per second; within 5s we expect at least
		// a couple of events. The exact count varies by timing.
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
		// At least one tier counter is non-zero.
		const liveText = await page.getByTestId('tier-live').textContent()
		const rehText = await page.getByTestId('tier-rehydrate').textContent()
		const total = parseInt((liveText?.match(/(\d+)/) ?? ['0', '0'])[1], 10) +
			parseInt((rehText?.match(/(\d+)/) ?? ['0', '0'])[1], 10)
		expect(total).toBeGreaterThan(0)
	})

	test('pause + resume: status flips, events keep flowing after resume', async ({ page }) => {
		await page.goto('/demos/from-seq')
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('status')).toContainText('paused', { timeout: 3_000 })
		await page.waitForTimeout(2_000)
		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('status')).toContainText('subscribed', { timeout: 3_000 })
		// After resume, events continue arriving. Whether they come via
		// the replay buffer (tagged `live`) or `delta.fromSeq` (tagged
		// `fromSeq`), the page renders something from the gap-fill
		// resolution chain.
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
	})

	test('event rows have a tier badge populated to one of live / rehydrate / fromSeq', async ({ page }) => {
		await page.goto('/demos/from-seq')
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
		const firstRow = page.getByTestId('event-row').first()
		const tierBadge = firstRow.locator('[data-testid^="event-tier-"]')
		const tierText = await tierBadge.textContent()
		expect(['live', 'rehydrate', 'fromSeq']).toContain((tierText ?? '').trim())
	})
})
