import { test, expect } from '@playwright/test'

/**
 * /demos/flags - live feature flags.
 *
 * Flag values are cluster-shared state (single-entry replay buffer),
 * so each test drives the operator card to an explicit known state
 * before asserting the user card, and restores the defaults on the
 * way out. The `main` project runs serially (workers=1), so no other
 * spec races these flips.
 */

async function waitForFlagsLoaded(page) {
	await page.goto('/demos/flags')
	// The operator controls stay disabled until both flag stores hold
	// a server-pushed value; the loading hint disappears at that point.
	await expect(page.getByTestId('fl-loading')).toHaveCount(0, { timeout: 15_000 })
	await expect(page.getByTestId('fl-banner-toggle')).toBeEnabled()
}

test.describe('/demos/flags', () => {
	test('banner flag round-trips the server and drives the user card', async ({ page }) => {
		await waitForFlagsLoaded(page)

		// Known state first: banner off.
		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
		await expect(page.getByTestId('fl-promo-off')).toBeVisible()

		// Toggle on: the same tab's user card renders the promo banner -
		// the value round-trips through setFlag -> flag.set -> publish.
		await page.getByTestId('fl-banner-toggle').setChecked(true)
		await expect(page.getByTestId('fl-promo-banner')).toBeVisible({ timeout: 10_000 })
		const bannerText = (await page.getByTestId('fl-banner-text').inputValue()).trim()
		expect(bannerText.length).toBeGreaterThan(0)
		await expect(page.getByTestId('fl-promo-banner')).toContainText(bannerText)

		// Restore the default.
		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
	})

	test('dark-launch rollout gates the checkout tile at 100 and 0', async ({ page }) => {
		await waitForFlagsLoaded(page)

		await page.getByTestId('fl-dark-toggle').setChecked(true)

		// rollout 100: every bucket (0-99) is below the threshold.
		await page.getByTestId('fl-rollout').fill('100')
		await expect(page.getByTestId('fl-rollout-value')).toHaveText('100%')
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('New checkout', { timeout: 10_000 })

		// rollout 0: no bucket qualifies.
		await page.getByTestId('fl-rollout').fill('0')
		await expect(page.getByTestId('fl-rollout-value')).toHaveText('0%')
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })

		// Restore the default.
		await page.getByTestId('fl-dark-toggle').setChecked(false)
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout')
	})

	test('operator card stays error-free across a full flip cycle', async ({ page }) => {
		await waitForFlagsLoaded(page)

		// The page's controls can only emit schema-valid values, so the
		// happy path must never surface a setFlag or subscribe error.
		await page.getByTestId('fl-dark-toggle').setChecked(true)
		await page.getByTestId('fl-dark-toggle').setChecked(false)
		await expect(page.getByTestId('fl-op-error')).toHaveCount(0)
		await expect(page.getByTestId('fl-flag-error')).toHaveCount(0)
	})
})
