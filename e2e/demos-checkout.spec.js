import { test, expect } from '@playwright/test'

test.describe('/demos/checkout idempotency', () => {
	test('single click increments the counter', async ({ page }) => {
		await page.goto('/demos/checkout')
		await page.getByRole('button', { name: 'Reset' }).click()
		await expect(page.locator('.tabular-nums')).toHaveText('0', { timeout: 5_000 })

		await page.getByRole('button', { name: 'Place Order', exact: true }).click()
		await expect(page.locator('.tabular-nums')).toHaveText('1', { timeout: 5_000 })

		await page.getByRole('button', { name: 'Place Order', exact: true }).click()
		await expect(page.locator('.tabular-nums')).toHaveText('2', { timeout: 5_000 })
	})

	test('Retry x5 with same key produces ONE increment, not five', async ({ page }) => {
		await page.goto('/demos/checkout')
		await page.getByRole('button', { name: 'Reset' }).click()
		await expect(page.locator('.tabular-nums')).toHaveText('0', { timeout: 5_000 })

		await page.getByRole('button', { name: 'Retry x5 (same key)' }).click()
		// Five RPCs fire concurrently with the same idempotencyKey.
		// Only the first runs the handler; the four cached returns must
		// not increment. End state: counter = 1.
		await expect(page.locator('.tabular-nums')).toHaveText('1', { timeout: 5_000 })

		// History should show 5 entries all returning count = 1.
		const historyCounts = await page.locator('.font-mono li .font-bold').allTextContents()
		expect(historyCounts).toHaveLength(5)
		for (const text of historyCounts) {
			expect(text).toBe('count = 1')
		}
	})

	test('counter syncs across two browser contexts', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/checkout')
			await b.goto('/demos/checkout')
			await a.getByRole('button', { name: 'Reset' }).click()
			await expect(a.locator('.tabular-nums')).toHaveText('0', { timeout: 5_000 })
			await expect(b.locator('.tabular-nums')).toHaveText('0', { timeout: 5_000 })

			await a.getByRole('button', { name: 'Place Order', exact: true }).click()
			await expect(b.locator('.tabular-nums')).toHaveText('1', { timeout: 5_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
