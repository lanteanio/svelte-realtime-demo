import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Delivery timing is genuinely asynchronous: the leader replica fires
// the POST, the sink writes Redis, and the page only sees it on its next
// 3s poll. The failing path additionally burns ~300+600+1200ms of
// jittered backoff (plus per-attempt latency) before dead-lettering.
// Every assertion therefore polls patiently instead of expecting
// immediacy.
test.describe('/demos/outbound-webhooks', () => {
	test('placing an order delivers a signed receipt', async ({ page }) => {
		await page.goto('/demos/outbound-webhooks')
		await waitForWS(page)

		await page.getByTestId('ow-place-ok').click()
		await expect(page.getByTestId('ow-last-order')).toBeVisible({ timeout: 10_000 })
		const placed = await page.getByTestId('ow-last-order').textContent()
		const shortId = placed?.match(/placed\s+(\w{8})/)?.[1]
		expect(shortId).toBeTruthy()

		// The receipt for OUR order must arrive, carry the verified-HMAC
		// badge, and echo the order id as its idempotency key.
		const receiptRow = page.getByTestId('ow-receipt-row').filter({ hasText: shortId ?? '' }).first()
		await expect(receiptRow).toBeVisible({ timeout: 15_000 })
		await expect(receiptRow.getByTestId('ow-sig-valid')).toBeVisible()
		await expect(receiptRow.getByTestId('ow-idem-key')).toContainText(shortId ?? '')
	})

	test('a failing order retries into the DLQ with a replay control', async ({ page }) => {
		await page.goto('/demos/outbound-webhooks')
		await waitForWS(page)

		await page.getByTestId('ow-place-fail').click()
		await expect(page.getByTestId('ow-last-order')).toBeVisible({ timeout: 10_000 })
		const placed = await page.getByTestId('ow-last-order').textContent()
		const shortId = placed?.match(/placed\s+(\w{8})/)?.[1]
		expect(shortId).toBeTruthy()

		// Retry exhaustion takes a few seconds; the DLQ row for our order
		// then shows on the next poll.
		const dlqRow = page.getByTestId('ow-dlq-row').filter({ hasText: shortId ?? '' }).first()
		await expect(dlqRow).toBeVisible({ timeout: 25_000 })
		await expect(dlqRow.getByTestId('ow-replay')).toBeVisible()
		await expect(page.getByTestId('ow-replay-all')).toBeEnabled()
	})
})
