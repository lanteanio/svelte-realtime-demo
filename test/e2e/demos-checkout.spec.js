import { test, expect } from '@playwright/test'
import { confirmAndClick, dismissConfirmation, waitForWS } from './helpers.js'

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
	// The copy instructs Retry, and Retry is the only control that shows the
	// page's point - but Place Order was the visual primary and came first, so
	// the click magnet was the CONTROL case, which increments the counter and
	// demonstrates nothing about idempotency. Asserted by comparing the two
	// buttons rather than by naming a class on one: a check for `btn-primary`
	// on Retry would pass while Place Order kept it too, which is exactly the
	// state being fixed.
	test('the instructed control is the visually primary one, and leads', async ({ page }) => {
		await open(page)
		const buttons = page.locator('button[data-testid^="checkout-"]')
		const order = await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
		expect(order.indexOf('checkout-retry'), 'the instructed button leads')
			.toBeLessThan(order.indexOf('checkout-place'))
		await expect(page.getByTestId('checkout-retry')).toHaveClass(/btn-primary/)
		await expect(page.getByTestId('checkout-place')).not.toHaveClass(/btn-primary/)
	})

	// The page promised "under double-click" and then absorbed a real
	// double-click in a disabled button, so what a visitor could actually
	// perform was defended by the UI, not by the primitive. The heading and
	// the note now say what is true; the note is the load-bearing half,
	// because a heading alone can be read as the lockout being the guarantee.
	test('the page names the lockout instead of letting it pass for the guarantee', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Idempotency under a retry storm')
		const note = page.getByTestId('checkout-lockout-note')
		await expect(note).toContainText('UI lockout, not idempotency')
		await expect(note).toContainText('five real overlapping RPCs')
		// And the lockout it describes is real, or the note is the new lie.
		//
		// Latched from inside the page rather than sampled from outside it. The
		// lockout is open only while the five RPCs are in flight, measured at
		// 7-10ms, and `toBeDisabled()` cannot evaluate until the click has
		// round-tripped out of the browser - so under load the window closes
		// before the first poll and every later one sees the settled state. That
		// made this assertion racy by construction: it was sampling a 9ms
		// transient, and passing only when the first poll happened to land
		// inside it. A MutationObserver installed BEFORE the click cannot miss
		// the transition however short it is, and it still fails if the lockout
		// never engages, which is the guarantee actually under test.
		await page.evaluate(() => {
			const target = document.querySelector('[data-testid="checkout-place"]')
			window.__lockoutSeen = target.hasAttribute('disabled')
			new MutationObserver(() => {
				if (target.hasAttribute('disabled')) window.__lockoutSeen = true
			}).observe(target, { attributes: true, attributeFilter: ['disabled'] })
		})
		await page.getByTestId('checkout-retry').click()
		// Settle on the storm finishing, so the latch is read after the window
		// it is meant to have caught rather than before it opened.
		await expect(page.getByTestId('checkout-retry')).toBeEnabled({ timeout: 10_000 })
		expect(
			await page.evaluate(() => window.__lockoutSeen),
			'Place Order must be locked out while the retry storm is in flight'
		).toBe(true)
	})

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

	// The history each-key embedded the array index, so a prepend re-keyed
	// every existing row and Svelte destroyed and rebuilt the whole list -
	// defeating the point of a keyed each. Asserted on IDENTITY, since a
	// rebuilt list looks identical in the DOM: stamp the existing nodes, add a
	// row, and require the stamped ones to have survived. Counting rows or
	// reading their text would pass either way.
	test('adding history preserves the existing rows instead of rebuilding them', async ({ page }) => {
		await open(page)
		await page.getByTestId('checkout-retry').click()
		await expect(page.getByTestId('checkout-history-row')).toHaveCount(5)

		await page.getByTestId('checkout-history-row').evaluateAll((rows) => {
			rows.forEach((row, i) => { row.dataset.survivor = String(i) })
		})
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-history-row')).toHaveCount(6)

		const survivors = await page.getByTestId('checkout-history-row')
			.evaluateAll((rows) => rows.filter((row) => row.dataset.survivor !== undefined).length)
		expect(survivors, 'the five pre-existing rows must be the same nodes, not rebuilt copies').toBe(5)
	})

	// The burst's only feedback was a dimmed button, and Promise.all made five
	// RPCs land as one atomic +1 - so the "five rapid RPCs" the copy promises
	// were never perceivable as five events, and on a slow link the page looks
	// inert for the whole round trip. Slowing the server's frames is what makes
	// the in-flight state observable at all: on localhost every reply settles
	// within a millisecond or two, so a bare click would sample the finished
	// state and the pin would be on nothing.
	test('a burst in flight says so, instead of looking inert until it lands', async ({ page }) => {
		const SERVER_DELAY = 800
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => { setTimeout(() => ws.send(m), SERVER_DELAY) })
		})
		await open(page)

		await page.getByTestId('checkout-retry').click()
		// Read both properties atomically, well inside the delay window: a
		// two-step assertion could race the delayed frames between the checks.
		await expect
			.poll(() => page.getByTestId('checkout-retry')
				.evaluate((el) => ({ disabled: el.disabled, text: el.textContent.trim() })))
			.toEqual({ disabled: true, text: 'Retry x5 (0/5 settled)' })

		// And it resolves to the whole burst rather than sticking on the count.
		await expect(page.getByTestId('checkout-history-row')).toHaveCount(5, { timeout: 15_000 })
		await expect(page.getByTestId('checkout-retry')).toHaveText('Retry x5 (same key)')
	})

	test('Reset zeroes the counter and clears the client history', async ({ page }) => {
		await open(page)
		// Seed some state first so the reset is observable, and settle on the
		// COUNTER rather than on the history row. The two arrive by different
		// deliveries: the row is appended when the RPC RESPONSE returns, while
		// the counter only moves when the live stream's PUBLISH lands. A baseline
		// read off the row therefore samples a counter the publish has not
		// reached yet; the publish then arrives during the dismiss round trip,
		// and the unchanged-after-cancel assertion below compares a settled value
		// against a stale baseline. Same read-then-act order the two tests above
		// already use.
		const seeded = await readCount(page)
		await page.getByTestId('checkout-place').click()
		await expect(page.getByTestId('checkout-count')).toHaveText(String(seeded + 1), { timeout: 10_000 })
		await expect(page.getByTestId('checkout-history-row')).not.toHaveCount(0)

		const beforeCancel = await readCount(page)
		const historyBeforeCancel = await page.getByTestId('checkout-history-row').count()
		const warning = await dismissConfirmation(page.getByTestId('checkout-reset'))
		expect(warning).toContain('Reset the checkout counter and history?')
		await expect(page.getByTestId('checkout-count')).toHaveText(String(beforeCancel))
		await expect(page.getByTestId('checkout-history-row')).toHaveCount(historyBeforeCancel)
		await expect(page.getByTestId('checkout-reset')).toHaveClass(/btn-outline/)
		await expect(page.getByTestId('checkout-reset')).toHaveClass(/btn-error/)

		await confirmAndClick(page.getByTestId('checkout-reset'))
		await expect(page.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })
		// The history list is client-side and is dropped on reset.
		await expect(page.getByTestId('checkout-history')).toHaveCount(0)
	})

	test('the counter survives a reload (live stream re-fetches from Redis)', async ({ page }) => {
		await open(page)
		await confirmAndClick(page.getByTestId('checkout-reset'))
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
			await confirmAndClick(a.getByTestId('checkout-reset'))
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
