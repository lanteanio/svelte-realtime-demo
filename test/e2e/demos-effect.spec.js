import { test, expect } from '@playwright/test'

const RUN = `e2e-${Date.now()}`

test.describe('/demos/effect', () => {
	test('renders three columns; place one order populates all three via the effect handler', async ({ page }) => {
		await page.goto('/demos/effect')
		await page.getByTestId('clear').click()
		await expect(page.getByTestId('orders-empty')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('audit-empty')).toBeVisible()
		await expect(page.getByTestId('notifications-empty')).toBeVisible()

		await page.getByTestId('place-product').selectOption('coffee')
		await page.getByTestId('place-qty').fill('2')
		await page.getByTestId('place-submit').click()

		// Orders column: 1 row with 2x coffee.
		await expect(page.getByTestId('orders-row')).toHaveCount(1, { timeout: 5_000 })
		await expect(page.getByTestId('orders-product').first()).toContainText('2x coffee')
		// Audit column: 1 row populated by the effect handler.
		await expect(page.getByTestId('audit-row')).toHaveCount(1, { timeout: 5_000 })
		await expect(page.getByTestId('audit-message').first()).toContainText('coffee')
		// Notifications column: 1 row populated by the SAME effect handler.
		await expect(page.getByTestId('notifications-row')).toHaveCount(1, { timeout: 5_000 })
		await expect(page.getByTestId('notifications-message').first()).toContainText('coffee')
	})

	test('burst (5 orders): all three columns reach 5 rows', async ({ page }) => {
		await page.goto('/demos/effect')
		await page.getByTestId('clear').click()
		await expect(page.getByTestId('orders-empty')).toBeVisible({ timeout: 5_000 })

		await page.getByTestId('burst').click()
		// In-memory feeds are server-global; parallel test workers may
		// place additional orders between clear and the burst tick.
		// Assert "at least 5" rather than exactly 5 to keep the burst-
		// fan-out assertion stable under shared-state pollution.
		await expect.poll(
			async () => await page.getByTestId('orders-row').count(),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(5)
		await expect.poll(
			async () => await page.getByTestId('audit-row').count(),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(5)
		await expect.poll(
			async () => await page.getByTestId('notifications-row').count(),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(5)
	})

	test('clear feeds: empty all three columns', async ({ page }) => {
		await page.goto('/demos/effect')
		// Place an order so the columns have at least one row each.
		// Don't assert the exact count: prior tests in the spec leave
		// state behind on the in-memory feeds. We only need "there's
		// some row, then clear, then no rows."
		await page.getByTestId('place-submit').click()
		await expect(page.getByTestId('audit-row').first()).toBeVisible({ timeout: 5_000 })
		await page.getByTestId('clear').click()
		await expect(page.getByTestId('orders-row')).toHaveCount(0, { timeout: 5_000 })
		await expect(page.getByTestId('audit-row')).toHaveCount(0, { timeout: 5_000 })
		await expect(page.getByTestId('notifications-row')).toHaveCount(0, { timeout: 5_000 })
	})
})
