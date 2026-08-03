import { test, expect } from '@playwright/test'
import {
	dlqCount,
	dlqRow,
	openOutbound,
	placeOrder,
	receiptRows,
	replayAll,
	replayOne,
	waitForDlq,
	waitForReceipts
} from './outbound-webhooks-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/outbound-webhooks', () => {
	test('renders every control, queue/receipt state, delivery disclosure, and related links', async ({ page }) => {
		await openOutbound(page)
		await expect(page.getByRole('heading', { name: 'Outbound webhooks: sign, retry, dead-letter, replay' })).toBeVisible()
		for (const id of ['ow-place-ok', 'ow-place-fail']) {
			await expect(page.getByTestId(id)).toBeVisible()
			await expect(page.getByTestId(id)).toBeEnabled()
		}
		for (const id of ['ow-receipts-card', 'ow-dlq-card']) await expect(page.getByTestId(id)).toBeVisible()
		const count = await dlqCount(page)
		if (count === 0) await expect(page.getByTestId('ow-replay-all')).toBeDisabled()
		else await expect(page.getByTestId('ow-replay-all')).toBeEnabled()
		await expect(page.getByText('300 / 600 / 1200ms', { exact: false })).toBeVisible()
		await expect(page.getByRole('link', { name: 'outbound-webhooks.js' })).toHaveAttribute(
			'href',
			/src\/live\/demos\/outbound-webhooks\.js$/
		)
		await expect(page.getByRole('link', { name: '/demos/ops' })).toHaveAttribute('href', '/demos/ops')
		await expect(page.getByTestId('ow-error')).toHaveCount(0)
		await expect(page.getByTestId('ow-replay-error')).toHaveCount(0)
		// The replay buttons are real-size controls, the replay APIs are
		// named for the visitor, and the long intro token wraps instead
		// of clipping at narrow content edges.
		await expect(page.getByTestId('ow-replay-all')).toHaveClass(/btn-sm/)
		await expect(page.getByTestId('ow-replay-all')).toHaveClass(/btn-outline/)
		await expect(page.getByText('getDeadLetter()', { exact: false })).toBeVisible()
		await expect(page.getByText('replayDeadLetter(ids)', { exact: false })).toBeVisible()
		await expect(page.locator('header code').first()).toHaveClass(/break-all/)
	})

	test('a successful order delivers a verified 200 receipt with its stable idempotency key', async ({ page }) => {
		await openOutbound(page)
		const shortId = await placeOrder(page, 'ok')
		const receipts = await waitForReceipts(page, shortId)
		expect(receipts.length).toBeGreaterThanOrEqual(1)
		for (const receipt of receipts) {
			expect(receipt.text).toMatch(/\b200\b/)
			expect(receipt.sigValid).toBe(true)
			expect(receipt.idempotencyKey).toContain(shortId)
		}
		await expect(dlqRow(page, shortId)).toHaveCount(0)
		// Millisecond stamps: the whole retry ladder fits inside two
		// wall-clock seconds, so second-resolution times hid the backoff.
		await expect(page.getByTestId('ow-receipt-row').first().locator('span').first()).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)
	})

	test('a hidden tab pauses polling, then catches up a same-identity tab order immediately on return', async ({ page, context }) => {
		await openOutbound(page)
		await page.evaluate(() => {
			window.__outboundE2EVisibility = 'hidden'
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => window.__outboundE2EVisibility
			})
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await page.waitForTimeout(300)

		const other = await context.newPage()
		try {
			await openOutbound(other)
			const shortId = await placeOrder(other, 'ok')
			await waitForReceipts(other, shortId)
			await page.waitForTimeout(3_500)
			await expect(receiptRows(page, shortId)).toHaveCount(0)

			await page.evaluate(() => {
				window.__outboundE2EVisibility = 'visible'
				document.dispatchEvent(new Event('visibilitychange'))
			})
			await waitForReceipts(page, shortId, 1, 8_000)
		} finally {
			await other.close()
		}
	})

	test('a failing order retries three times, dead-letters, and per-record replay re-runs the same payload', async ({ page }) => {
		test.setTimeout(45_000)
		await openOutbound(page)
		const shortId = await placeOrder(page, 'fail')
		// The retry window narrates itself instead of happening invisibly
		// between polls, and the strip retires when the dead letter lands.
		await expect(page.getByTestId('ow-retrying')).toContainText('retries are running')
		await expect(page.getByTestId('ow-retrying')).toContainText(shortId)
		await waitForDlq(page, shortId)
		await expect(page.getByTestId('ow-retrying')).toHaveCount(0)
		const firstReceipts = await waitForReceipts(page, shortId, 3)
		for (const receipt of firstReceipts) {
			expect(receipt.text).toMatch(/\b500\b/)
			expect(receipt.sigValid).toBe(true)
			expect(receipt.idempotencyKey).toContain(shortId)
		}
		const keys = new Set(firstReceipts.map((receipt) => receipt.idempotencyKey))
		expect(keys.size).toBe(1)

		const replay = await replayOne(page, shortId)
		expect(replay).toEqual({ replayed: 0, total: 1 })
		await expect.poll(() => receiptRows(page, shortId).count(), { timeout: 25_000 })
			.toBeGreaterThan(firstReceipts.length)
		await waitForDlq(page, shortId)
	})

	test('Replay all drives every visible dead letter through the complete failing path again', async ({ page }) => {
		test.setTimeout(60_000)
		await openOutbound(page)
		const tracked = await placeOrder(page, 'fail')
		await waitForDlq(page, tracked)
		const beforeReceipts = await receiptRows(page, tracked).count()
		const beforeDlq = await dlqCount(page)
		expect(beforeDlq).toBeGreaterThanOrEqual(2)

		const result = await replayAll(page)
		expect(result.replayed).toBe(0)
		expect(result.total).toBeGreaterThanOrEqual(beforeDlq)
		await expect.poll(() => receiptRows(page, tracked).count(), { timeout: 30_000 })
			.toBeGreaterThan(beforeReceipts)
		await expect.poll(() => dlqCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(beforeDlq)
		await waitForDlq(page, tracked)
	})

})
