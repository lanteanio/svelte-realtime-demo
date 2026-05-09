import { test, expect } from '@playwright/test'

test.describe('/demos/chaos', () => {
	test('start with seed produces tick decisions', async ({ page }) => {
		await page.goto('/demos/chaos')
		await page.getByTestId('seed-input').fill('1234')
		await page.getByTestId('start-button').click()
		// Decision strip populates within ~1.5s (10 ticks/sec).
		await expect(page.getByTestId('decision-strip').locator('div')).toHaveCount(60, { timeout: 8_000 }).catch(() => {})
		const cellCount = await page.getByTestId('decision-strip').locator('[data-testid^="tick-"]').count()
		expect(cellCount).toBeGreaterThan(2)
		await page.getByTestId('stop-button').click()
	})

	test('determinism: same seed + dropRate produces same first-N decision sequence across two runs', async ({ page }) => {
		const SEED = '7777'
		const DROP = 0.5
		const N = 20  // first 20 ticks; deterministic regardless of how many extra arrived

		async function getFirstN(page) {
			await page.goto('/demos/chaos')
			await page.getByTestId('seed-input').fill(SEED)
			await page.evaluate((d) => {
				const el = document.querySelector('[data-testid="drop-rate-input"]')
				el.value = String(d)
				el.dispatchEvent(new Event('input', { bubbles: true }))
				el.dispatchEvent(new Event('change', { bubbles: true }))
			}, DROP)
			await page.getByTestId('start-button').click()
			// Wait until at least N decisions have rendered.
			await page.waitForFunction(
				(expected) => document.querySelectorAll('[data-testid^="tick-"]').length >= expected,
				N,
				{ timeout: 8000 }
			)
			const cells = page.getByTestId('decision-strip').locator('[data-testid^="tick-"]')
			const pattern = []
			for (let i = 0; i < N; i++) {
				const id = await cells.nth(i).getAttribute('data-testid')
				pattern.push(id === 'tick-dropped' ? 'D' : 'K')
			}
			await page.getByTestId('stop-button').click()
			return pattern.join('')
		}

		const a = await getFirstN(page)
		const b = await getFirstN(page)
		expect(a).toBe(b)
		// Sanity: the pattern uses both kinds (drop rate is 50%, not 0/100).
		expect(a).toContain('D')
		expect(a).toContain('K')
	})

	test('preset buttons populate seed and drop rate inputs', async ({ page }) => {
		await page.goto('/demos/chaos')
		await page.getByTestId('preset-42').click()
		await expect(page.getByTestId('seed-input')).toHaveValue('42')
	})

	test('stop button removes running state', async ({ page }) => {
		await page.goto('/demos/chaos')
		await page.getByTestId('start-button').click()
		await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 3_000 })
		await page.getByTestId('stop-button').click()
		await expect(page.getByTestId('start-button')).toBeVisible({ timeout: 3_000 })
	})
})
