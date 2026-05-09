import { test, expect } from '@playwright/test'

test.describe('/demos/counter-resume', () => {
	test('counter ticks live', async ({ page }) => {
		await page.goto('/demos/counter-resume')
		// Wait for first tick to populate.
		await expect.poll(
			async () => Number(await page.locator('.text-7xl').textContent()) || 0,
			{ timeout: 5_000 }
		).toBeGreaterThan(0)
		const start = Number(await page.locator('.text-7xl').textContent())
		// Wait ~3 seconds; counter should have advanced by at least 2.
		await page.waitForTimeout(3000)
		const after = Number(await page.locator('.text-7xl').textContent())
		expect(after).toBeGreaterThanOrEqual(start + 2)
	})

	test('disconnect + reconnect catches up via replay', async ({ page, context }) => {
		await page.goto('/demos/counter-resume')
		await expect.poll(
			async () => Number(await page.locator('.text-7xl').textContent()) || 0,
			{ timeout: 5_000 }
		).toBeGreaterThan(0)
		const beforeOffline = Number(await page.locator('.text-7xl').textContent())

		// Drop the network. Server keeps ticking.
		await context.setOffline(true)
		await page.waitForTimeout(4000)

		// Counter should NOT have advanced while offline (no events arriving).
		const duringOffline = Number(await page.locator('.text-7xl').textContent())
		expect(duringOffline).toBe(beforeOffline)

		// Reconnect. Resume protocol fills the gap.
		await context.setOffline(false)
		await expect.poll(
			async () => Number(await page.locator('.text-7xl').textContent()) || 0,
			{ timeout: 10_000 }
		).toBeGreaterThan(beforeOffline + 2)

		// Ledger should record at least one entry tagged as a gap (the
		// catch-up arrival after the offline window).
		const gapBadges = await page.locator('.badge-warning').count()
		expect(gapBadges).toBeGreaterThan(0)
	})
})
