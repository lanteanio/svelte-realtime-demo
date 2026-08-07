import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
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

	// The finding was measured at 412, 390, 360 and 320, where the unbroken
	// token lost characters off the content edge - "demos:outbo" at 320. The
	// existing pin asserts the break-all CLASS, which a `whitespace-nowrap`
	// sitting beside it satisfies while clipping exactly as before. Measure the
	// overflow itself, at the rungs the finding named.
	test('the intro token wraps instead of clipping at every narrow rung', async ({ browser }) => {
		for (const [width, height] of [[412, 915], [390, 844], [360, 640], [320, 568]]) {
			const context = await browser.newContext({ viewport: { width, height } })
			const page = await context.newPage()
			try {
				await openOutbound(page)
				// Measured with getClientRects against the PARENT's content
				// width, not scrollWidth/clientWidth on the code element
				// itself: <code> is a non-replaced inline box, and both of
				// those are defined as 0 there, so the obvious version of this
				// assertion reads 0 <= 0 and passes whatever the token does.
				// A wrapped token produces several rects, each inside the
				// content width; an unwrappable one produces a single rect
				// wider than it, and that overhang is the clipping.
				const size = await page.locator('header code').first().evaluate((el) => {
					const parent = el.parentElement
					const style = getComputedStyle(parent)
					const contentWidth = parent.clientWidth
						- parseFloat(style.paddingLeft || '0')
						- parseFloat(style.paddingRight || '0')
					const rects = Array.from(el.getClientRects())
					return { widest: Math.max(...rects.map((r) => r.width)), contentWidth, lines: rects.length }
				})
				// Guard against the measurement silently going vacuous again.
				expect(size.contentWidth, 'measured a zero-width container').toBeGreaterThan(0)
				expect(size.lines, 'measured no rendered line boxes').toBeGreaterThan(0)
				expect(
					size.widest,
					`the intro token overhangs its container by ${Math.round(size.widest - size.contentWidth)}px at ${width}x${height}, so characters are clipped`
				).toBeLessThanOrEqual(size.contentWidth + 1)
			} finally {
				await context.close()
			}
		}
	})

	// The suite pinned btn-sm and btn-outline as CLASSES, on a fine pointer.
	// Both survive deleting the coarse-pointer floor, which is the entire
	// finding - these were the smallest targets on the page and they are the
	// last step of the stated success line.
	test('the replay controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openOutbound(page)
			await expectTouchTarget(page.getByTestId('ow-replay-all'))
			// The per-row control exists only once there are dead letters, so
			// earn one rather than quietly skip the half of the finding it
			// belongs to. Waiting for the ROW is enough - the full waitForDlq
			// helper also pins the retry state (attempts: 3, HTTP 500), which
			// this test does not need and which would make a geometry
			// assertion depend on retry timing.
			const shortId = await placeOrder(page, 'fail')
			const row = dlqRow(page, shortId)
			await expect(row).toBeVisible({ timeout: 30_000 })
			await expectTouchTarget(row.getByTestId('ow-replay'))
		} finally {
			await context.close()
		}
	})

	// The card is about WHERE a replay failure reports. The suite asserted only
	// that both error slots are absent AT REST, which is satisfied by any
	// arrangement at all - including the original single shared lastError that
	// reported two cards above the button. That assertion cannot fail on this
	// defect, so it never tested it.
	//
	// It was recorded as untestable because there is no way to make only the
	// replay RPC fail. There is: the client rejects pending calls when the
	// socket drops, so closing it with the replay call in flight is a real
	// replay failure, not a simulated error string. Arming the interception
	// only after the dead letter exists keeps it from firing on unrelated
	// traffic during setup.
	test('a replay failure reports beside the Replay button, not two cards above it', async ({ page }) => {
		let armed = false
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((message) => {
				server.send(message)
				if (armed && typeof message === 'string' && /replay/i.test(message)) ws.close()
			})
			server.onMessage((message) => ws.send(message))
		})
		await openOutbound(page)
		// Any dead letter enables Replay all, which is all this test needs; the
		// full retry-state helper would tie an error-placement assertion to
		// retry timing for no benefit.
		const shortId = await placeOrder(page, 'fail')
		await expect(dlqRow(page, shortId)).toBeVisible({ timeout: 30_000 })
		await expect(page.getByTestId('ow-replay-all')).toBeEnabled()

		armed = true
		await page.getByTestId('ow-replay-all').click()

		// It must render, and render INSIDE the DLQ card beside the control
		// that caused it...
		await expect(page.getByTestId('ow-dlq-card').getByTestId('ow-replay-error'))
			.toBeVisible({ timeout: 20_000 })
		// ...while the place card's slot stays empty. A single shared error
		// state could not satisfy both of these at once, which is what makes
		// this pair discriminating rather than decorative.
		await expect(page.getByTestId('ow-error')).toHaveCount(0)
	})

})
