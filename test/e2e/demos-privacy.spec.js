import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/privacy', () => {
	test('renders the mood picker, both aggregate cards, and the explainer', async ({ page }) => {
		await page.goto('/demos/privacy')
		for (const score of [1, 2, 3, 4, 5]) {
			await expect(page.getByTestId(`pv-submit-${score}`)).toBeVisible()
		}
		await expect(page.getByTestId('pv-raw-card')).toBeVisible()
		await expect(page.getByTestId('pv-protected-card')).toBeVisible()
		// Explainer names the mechanism.
		await expect(page.getByTestId('pv-explainer')).toContainText('k-anonymity')
		await expect(page.getByTestId('pv-explainer')).toContainText('privacy')
	})

	test('a single submission moves the raw aggregate while the protected card holds', async ({ page }) => {
		await page.goto('/demos/privacy')
		await waitForWS(page)

		// Capture the protected card's value area before submitting. A single
		// browser context is a single contributor, so k = 3 cannot be crossed
		// here; the area must be byte-identical afterwards.
		const before = (await page.getByTestId('pv-protected-value-area').textContent())?.trim()

		await page.getByTestId('pv-submit-4').click()
		await expect(page.getByTestId('pv-submit-note')).toBeVisible({ timeout: 5_000 })

		// Raw card reacts: at least our submission is counted this round.
		await expect.poll(async () => {
			const n = page.getByTestId('pv-raw-n')
			if ((await n.count()) === 0) return 0
			return Number(await n.textContent())
		}, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
		await expect(page.getByTestId('pv-raw-avg')).toBeVisible()

		// Give any (incorrect) protected publish time to fan out, then assert
		// the protected card did not move.
		await page.waitForTimeout(1_500)
		const after = (await page.getByTestId('pv-protected-value-area').textContent())?.trim()
		expect(after).toBe(before)

		// The contributor hint reflects this round's cohort progress.
		await expect.poll(async () => {
			const d = page.getByTestId('pv-round-distinct')
			if ((await d.count()) === 0) return 0
			return Number(await d.textContent())
		}, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
		await expect(page.getByTestId('pv-round-k')).toHaveText('3')
	})
})
