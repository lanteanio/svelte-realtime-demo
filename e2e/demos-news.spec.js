import { test, expect } from '@playwright/test'

test.describe('/demos/news', () => {
	test('renders trending panels, stats strip, publish form, and speed slider', async ({ page }) => {
		await page.goto('/demos/news')
		await expect(page.getByTestId('lb-news-last30s')).toBeVisible()
		await expect(page.getByTestId('lb-news-thisMinute')).toBeVisible()
		await expect(page.getByTestId('lb-news-lifetime')).toBeVisible()
		await expect(page.getByTestId('news-stats-strip')).toBeVisible()
		await expect(page.getByTestId('news-publish-form')).toBeVisible()
		await expect(page.getByTestId('news-speed-input')).toBeVisible()
		await expect(page.getByTestId('news-headline-input')).toBeVisible()
		await expect(page.getByTestId('news-publish-button')).toBeVisible()
	})

	test('lifetime leaderboard populates from the firehose within 8s', async ({ page }) => {
		await page.goto('/demos/news')
		// Default speed=5 picks from the 6 seed stories so the lifetime
		// aggregate has counts to publish within a couple of cron ticks.
		await expect(page.getByTestId('lb-news-lifetime-rows')).toBeVisible({ timeout: 10_000 })
		const rows = await page.getByTestId('lb-news-lifetime-row').count()
		expect(rows).toBeGreaterThanOrEqual(1)
		expect(rows).toBeLessThanOrEqual(5)
	})

	test('publish form round-trips through the webhook and the story appears in the list', async ({ page }) => {
		await page.goto('/demos/news')
		// Wait for the seed stories to render so we have a baseline.
		await expect(page.getByTestId('news-story').first()).toBeVisible({ timeout: 10_000 })

		// A timestamp suffix makes the headline unique across re-runs and
		// against any seed/runtime entries already present.
		const unique = `Probe headline ${Date.now()}`
		await page.getByTestId('news-headline-input').fill(unique)
		await page.getByTestId('news-summary-input').fill('Routed via /api/demos/news/webhook with HMAC signature.')
		await page.getByTestId('news-publish-button').click()

		// Success banner means the webhook returned 200; story should land
		// in the stories topic on the same tick.
		await expect(page.getByTestId('news-publish-ok')).toBeVisible({ timeout: 8_000 })

		// The new story shows up in the list with a 'webhook' badge.
		await expect(page.getByTestId('news-story-headline').filter({ hasText: unique })).toBeVisible({ timeout: 5_000 })
	})

	test('newsStats derived stream tracks story count and view count', async ({ page }) => {
		await page.goto('/demos/news')

		// Stats start at 6 seed stories. The derived recomputes when the
		// lifetime aggregate publishes (1Hz under default firehose) or a
		// new story arrives, so initial render may briefly show 0 before
		// the first lifetime tick lands.
		await expect.poll(
			async () => Number((await page.getByTestId('stat-totalStories').textContent())?.trim() ?? '0'),
			{ timeout: 10_000 }
		).toBeGreaterThanOrEqual(6)

		// totalViews should climb above zero within a few seconds at
		// default speed=5.
		await expect.poll(
			async () => Number((await page.getByTestId('stat-totalViews').textContent())?.trim() ?? '0'),
			{ timeout: 10_000 }
		).toBeGreaterThan(0)

		// Publishing a new story bumps totalStories.
		const before = Number((await page.getByTestId('stat-totalStories').textContent())?.trim() ?? '0')
		await page.getByTestId('news-headline-input').fill(`Stats probe ${Date.now()}`)
		await page.getByTestId('news-publish-button').click()
		await expect(page.getByTestId('news-publish-ok')).toBeVisible({ timeout: 8_000 })

		await expect.poll(
			async () => Number((await page.getByTestId('stat-totalStories').textContent())?.trim() ?? '0'),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(before + 1)
	})
})
