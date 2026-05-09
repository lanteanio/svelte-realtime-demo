import { test, expect } from '@playwright/test'

const RUN = `e2e-${Date.now()}`

test.describe('/demos/pagination', () => {
	test('initial render: page 1 (25 entries) visible, hasMore=true', async ({ page }) => {
		await page.goto('/demos/pagination')
		await expect(page.getByTestId('entry-row')).toHaveCount(25, { timeout: 8_000 })
		await expect(page.getByTestId('entries-count')).toHaveText('25')
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: true')
	})

	test('loadMore appends next page: 50 entries after one click', async ({ page }) => {
		await page.goto('/demos/pagination')
		await expect(page.getByTestId('entry-row')).toHaveCount(25, { timeout: 8_000 })
		await page.getByTestId('load-more').click()
		await expect(page.getByTestId('entry-row')).toHaveCount(50, { timeout: 8_000 })
		await expect(page.getByTestId('entries-count')).toHaveText('50')
	})

	test('append publishes a created event; new entry lands at the bottom of the visible list', async ({ page }) => {
		await page.goto('/demos/pagination')
		await expect(page.getByTestId('entry-row')).toHaveCount(25, { timeout: 8_000 })
		const before = await page.getByTestId('entry-row').count()
		const tag = `appended-${RUN}`
		await page.getByTestId('append-message').fill(tag)
		await page.getByTestId('append-severity').selectOption('error')
		await page.getByTestId('append-submit').click()
		await expect(page.getByTestId('entry-row')).toHaveCount(before + 1, { timeout: 5_000 })
		// Newest entry appears at the bottom (last row).
		const lastRow = page.getByTestId('entry-row').last()
		await expect(lastRow.getByTestId('entry-message')).toHaveText(tag)
		await expect(lastRow.getByTestId('entry-severity')).toHaveText('error')
	})

	test('exhaust pagination: load until hasMore=false; button disables', async ({ page }) => {
		await page.goto('/demos/pagination')
		await expect(page.getByTestId('entry-row')).toHaveCount(25, { timeout: 8_000 })
		// Loop until hasMore flips. 200 entries / 25 page = 8 pages total
		// at the seed; prior tests in the same module load may have
		// appended a few entries which adds another short final page.
		// Cap at 12 iterations to bound the loop in case state diverges.
		for (let i = 0; i < 12; i++) {
			const stateText = await page.getByTestId('has-more-state').textContent()
			if (stateText?.includes('hasMore: false')) break
			await page.getByTestId('load-more').click()
			await page.waitForTimeout(150)
		}
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: false', { timeout: 5_000 })
		await expect(page.getByTestId('load-more')).toBeDisabled()
	})
})
