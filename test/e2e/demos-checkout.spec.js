import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/checkout - the idempotency demo.
// Drives Place Order, Retry x5 (same key), Reset, and asserts REAL outcomes:
// a fresh click increments by exactly one, five same-key RPCs increment by
// exactly one (four cached), the history labels each retry, Reset zeroes the
// counter and clears history, and the live counter syncs across tabs.
//
// The counter is a single cluster-shared Redis key, so tests read the count
// before acting and assert the delta rather than an absolute value (except
// the Reset test, which asserts zero). The cross-replica assertions live in
// demos-checkout.cluster.spec.js.

async function readCount(page) {
	return Number((await page.getByTestId('checkout-count').textContent())?.trim() || 0)
}

async function open(page) {
	await page.goto('/demos/checkout')
	await waitForWS(page)
	// Wait for the live count STREAM to actually hydrate. The element shows
	// the "0" fallback ({$count ?? 0}) before the first frame lands, so gating
	// on a numeric text would pass on the fallback and let a delta read snapshot
	// a stale 0. data-hydrated flips true only once $count is defined.
	await expect(page.getByTestId('checkout-count')).toHaveAttribute('data-hydrated', 'true', { timeout: 10_000 })
}

test.describe('/demos/checkout idempotency', () => {
	test('Place Order increments the counter by exactly one per click', async ({ page }) => {
		await open(page)
		const before = await readCount(page)
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-count')).toHaveText(String(before + 1), { timeout: 10_000 })
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-count')).toHaveText(String(before + 2), { timeout: 10_000 })

		// The history records each fresh intent with its own key and the
		// returned count.
		await expect(page.getByTestId('checkout-history-row')).toHaveCount(2)
		await expect(page.getByTestId('checkout-history-label').first()).toHaveText('fresh')
	})

	test('Retry x5 with one idempotency key increments by exactly one, not five', async ({ page }) => {
		await open(page)
		const before = await readCount(page)
		await page.getByTestId('checkout-retry').click()

		// Only the first of five RPCs runs the handler; the counter moves by 1.
		await expect(page.getByTestId('checkout-count')).toHaveText(String(before + 1), { timeout: 10_000 })

		// History shows five rows that ALL return the same count, one labelled
		// the effect and four labelled cached retries.
		const counts = page.getByTestId('checkout-history-count')
		await expect(counts).toHaveCount(5, { timeout: 10_000 })
		for (const text of await counts.allTextContents()) {
			expect(text).toBe(`count = ${before + 1}`)
		}
		const labels = await page.getByTestId('checkout-history-label').allTextContents()
		expect(labels.filter((l) => l.includes('effect'))).toHaveLength(1)
		expect(labels.filter((l) => l.includes('cached'))).toHaveLength(4)
	})

	test('Reset zeroes the counter and clears the client history', async ({ page }) => {
		await open(page)
		// Seed some state first so the reset is observable.
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-history-row')).not.toHaveCount(0)

		await page.getByTestId('checkout-reset').click()
		await expect(page.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })
		// The history list is client-side and is dropped on reset.
		await expect(page.getByTestId('checkout-history')).toHaveCount(0)
	})

	test('the counter survives a reload (live stream re-fetches from Redis)', async ({ page }) => {
		await open(page)
		await page.getByTestId('checkout-reset').click()
		await expect(page.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-count')).toHaveText('1', { timeout: 10_000 })

		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('checkout-count')).toHaveText('1', { timeout: 10_000 })
	})

	test('the live counter syncs across two tabs', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			await a.getByTestId('checkout-reset').click()
			await expect(a.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })
			await expect(b.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })

			// A places an order; B's live stream reflects it without a reload.
			await a.getByTestId('checkout-place').click()
			await expect(b.getByTestId('checkout-count')).toHaveText('1', { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
