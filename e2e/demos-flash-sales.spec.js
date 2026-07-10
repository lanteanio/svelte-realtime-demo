import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

const PRODUCT_IDS = ['phone', 'watch', 'speaker']

async function reset(page) {
	await page.goto('/demos/flash-sales')
	await waitForWS(page)
	// Clear any state left over from a prior test run before asserting.
	await page.getByTestId('reset').click()
	for (const id of PRODUCT_IDS) {
		await expect(page.getByTestId(`product-stock-${id}`)).toContainText('left', { timeout: 5_000 })
	}
}

test.describe('/demos/flash-sales', () => {
	test('renders three products with full initial stock', async ({ page }) => {
		await reset(page)
		await expect(page.getByTestId('product-card-phone')).toBeVisible()
		await expect(page.getByTestId('product-card-watch')).toBeVisible()
		await expect(page.getByTestId('product-card-speaker')).toBeVisible()
		// Stock badges show "N / N left" at full state.
		await expect(page.getByTestId('product-stock-phone')).toHaveText('5 / 5 left')
		await expect(page.getByTestId('product-stock-watch')).toHaveText('3 / 3 left')
		await expect(page.getByTestId('product-stock-speaker')).toHaveText('8 / 8 left')
	})

	test('single buy: stock decrements by 1; sales feed shows the entry', async ({ page }) => {
		await reset(page)
		await page.getByTestId('product-buy-phone').click()
		await expect(page.getByTestId('product-stock-phone')).toHaveText('4 / 5 left', { timeout: 5_000 })
		await expect(page.getByTestId('product-sold-phone')).toHaveText('sold: 1')
		await expect(page.getByTestId('buy-outcome-kind')).toHaveText('sold')
		// Sales feed populated.
		await expect(page.getByTestId('sales-row')).toHaveCount(1)
	})

	test('sold-out: buy until stock hits 0; button disables and SOLD OUT badge appears', async ({ page }) => {
		await reset(page)
		// Watch has only 3 units. Click 3 times. The buyButton disables
		// during in-flight calls so we await each before clicking again.
		const buy = page.getByTestId('product-buy-watch')
		for (let i = 0; i < 3; i++) {
			await buy.click()
			await expect(page.getByTestId(`product-stock-watch`).or(page.getByTestId('product-soldout-watch'))).toBeVisible({ timeout: 5_000 })
		}
		await expect(page.getByTestId('product-soldout-watch')).toBeVisible({ timeout: 5_000 })
		await expect(buy).toBeDisabled()
		// One more attempt would be blocked by the disabled button; we
		// also assert the server's SOLD_OUT path via the stress test below.
	})

	test('stress 25 buys at one product: ok+sold-out totals match initial stock; counters reflect it', async ({ page }) => {
		await reset(page)
		// Drive 25 concurrent buys at a 5-unit product. Outcomes: 5 ok,
		// the rest split across SOLD_OUT and (under heavy contention)
		// LOCK_TIMEOUT. The lock guarantees stock never goes negative.
		await page.getByTestId('stress-target').selectOption('phone')
		await page.getByTestId('stress-count').fill('25')
		await page.getByTestId('stress-go').click()
		await expect(page.getByTestId('stress-result')).toBeVisible({ timeout: 15_000 })
		// Phone is sold out and shows the SOLD OUT badge.
		await expect(page.getByTestId('product-soldout-phone')).toBeVisible()
		// Exactly 5 successful buys (matches initial stock); the rest are
		// rejected as SOLD_OUT or LOCK_TIMEOUT (no oversold, no negative
		// stock). Read the badge tally back.
		const okText = await page.getByTestId('stress-ok').textContent()
		expect(okText).toContain('5 ok')
		// Phone's sold counter shows exactly 5.
		await expect(page.getByTestId('product-sold-phone')).toHaveText('sold: 5')
	})

	test('coupon: first claim ok; second claim returns the cached first response', async ({ page }) => {
		await reset(page)
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-result')).toContainText('Claimed', { timeout: 5_000 })
		await expect(page.getByTestId('coupon-result')).toContainText('SAVE20')
		// Pool decremented from 50 to 49.
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
		// Click again. Idempotent returns the cached response; the page's
		// `alreadyClaimed` flag flipped to true on first success, so the
		// second click renders as `Already claimed`.
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-result')).toContainText('Already claimed', { timeout: 5_000 })
		// Pool still at 49 (no second decrement).
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
	})
})
