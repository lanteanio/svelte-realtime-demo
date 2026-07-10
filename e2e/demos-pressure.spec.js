import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/pressure', () => {
	test('live pressure readout populates within a few sample windows', async ({ page }) => {
		await page.goto('/demos/pressure')
		await waitForWS(page)
		// Reason badge should leave the loading '...' state. The pressure
		// stream is fed by a 1Hz cron tick; under parallel test load the
		// first usable tick may take >2s. Give it more headroom.
		await expect(page.getByTestId('reason')).not.toHaveText('...', { timeout: 8_000 })
		// Sparkline should have at least one bar after a couple of ticks.
		await expect.poll(
			async () => await page.getByTestId('sparkline').locator('div').count(),
			{ timeout: 8_000 }
		).toBeGreaterThan(0)
	})

	test('Simulate shed adds an entry to the shed log', async ({ page }) => {
		await page.goto('/demos/pressure')
		await waitForWS(page)
		// Clean any leftover from prior runs.
		await page.getByTestId('clear-shed').click()
		await page.waitForTimeout(200)

		await page.getByTestId('simulate-shed').click()
		await expect(page.getByTestId('shed-log')).toContainText('simulateShed', { timeout: 5_000 })
		await expect(page.getByTestId('shed-log')).toContainText('simulated')
	})

	test('Generate load (5000) bumps publishRate', async ({ page }) => {
		await page.goto('/demos/pressure')
		await waitForWS(page)
		// Wait for first tick so we have a baseline reading. Allow more
		// headroom for parallel-test cron contention.
		await expect(page.getByTestId('reason')).not.toHaveText('...', { timeout: 10_000 })

		// Spam: hit +5000 several times to drive publishRate up over a sample
		// window (the adapter samples per second; one click is one publishBatched
		// call per ~1s window).
		await page.getByTestId('load-5000').click()
		await page.waitForTimeout(800)
		await page.getByTestId('load-5000').click()
		await page.waitForTimeout(800)
		await page.getByTestId('load-5000').click()

		// Production reports the adapter's global publish rate. Vite's dev
		// platform deliberately reports a zero pressure snapshot, so the demo
		// labels and exposes its own generated-event window there instead.
		// Either source must reflect the burst within a few sample windows.
		const rate = page.getByTestId('publish-rate')
		await expect.poll(
			async () => Number(await rate.textContent()),
			{ timeout: 5_000 }
		).toBeGreaterThan(0)
		expect(['adapter', 'generated-load-dev']).toContain(await rate.getAttribute('data-rate-source'))
	})

	test('Clear shed log empties the list', async ({ page }) => {
		await page.goto('/demos/pressure')
		await waitForWS(page)
		await page.getByTestId('simulate-shed').click()
		await expect(page.getByTestId('shed-log')).toContainText('simulateShed', { timeout: 3_000 })

		await page.getByTestId('clear-shed').click()
		await expect(page.getByTestId('shed-log')).toContainText('No shed decisions yet', { timeout: 3_000 })
	})
})
