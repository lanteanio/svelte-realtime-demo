import { test, expect } from '@playwright/test'

test.describe('/demos/topk', () => {
	test('renders all four leaderboards plus speed slider and bias controls', async ({ page }) => {
		await page.goto('/demos/topk')
		await expect(page.getByTestId('lb-last10s')).toBeVisible()
		await expect(page.getByTestId('lb-last1min')).toBeVisible()
		await expect(page.getByTestId('lb-thisMinute')).toBeVisible()
		await expect(page.getByTestId('lb-lifetime')).toBeVisible()
		await expect(page.getByTestId('speed-input')).toBeVisible()
		await expect(page.getByTestId('bias-uniform')).toBeVisible()
		await expect(page.getByTestId('bias-hot')).toBeVisible()
		await expect(page.getByTestId('bias-monopoly')).toBeVisible()
	})

	test('lifetime leaderboard populates from the firehose within 5s', async ({ page }) => {
		await page.goto('/demos/topk')
		// Default speed=5, so within a few seconds the firehose generates
		// enough events for the lifetime aggregate to publish a top-5.
		await expect(page.getByTestId('lb-lifetime-rows')).toBeVisible({ timeout: 8_000 })
		const rows = await page.getByTestId('lb-lifetime-row').count()
		expect(rows).toBeGreaterThanOrEqual(1)
		expect(rows).toBeLessThanOrEqual(5)
	})

	test('sliding last-10s window decays after speed is set to 0', async ({ page }) => {
		await page.goto('/demos/topk')
		// Wait for the firehose to populate something on last10s.
		await expect(page.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 8_000 })

		// Stop the firehose.
		await page.getByTestId('speed-input').fill('0')
		await page.getByTestId('speed-input').dispatchEvent('change')

		// Wait long enough for every existing event to age out of the
		// 10-second sliding window. 12s gives us 2s of slack on the slide
		// boundary so the test isn't flaky on a busy CI node.
		// The window's empty state shows the "Waiting for first events..."
		// hint via the lb-last10s-empty testid.
		await expect(page.getByTestId('lb-last10s-empty')).toBeVisible({ timeout: 14_000 })

		// Lifetime should still have entries (it never decays).
		await expect(page.getByTestId('lb-lifetime-rows')).toBeVisible()

		// Restore the firehose so the next test starts in the default state.
		await page.getByTestId('speed-input').fill('5')
		await page.getByTestId('speed-input').dispatchEvent('change')
	})

	test('setting bias to monopoly makes Midnight Drift dominate the lifetime leaderboard', async ({ page }) => {
		await page.goto('/demos/topk')
		// Wait for the page to populate before changing bias so we have a
		// baseline to compare against.
		await expect(page.getByTestId('lb-lifetime-rows')).toBeVisible({ timeout: 8_000 })

		// Switch to monopoly: ~75% of new events go to 'midnight'.
		await page.getByTestId('bias-monopoly').click()

		// Within ~6s the lifetime leaderboard's #1 should be Midnight Drift.
		// (Speed=5/sec * 6s * 0.75 = ~22 monopoly events, enough to shift
		// the leader against any prior uniform / hot baseline.)
		await expect.poll(
			async () => (await page.getByTestId('lb-lifetime-name').first().textContent())?.trim(),
			{ timeout: 12_000 }
		).toBe('Midnight Drift')

		// Restore default bias for the next test.
		await page.getByTestId('bias-uniform').click()
	})
})
