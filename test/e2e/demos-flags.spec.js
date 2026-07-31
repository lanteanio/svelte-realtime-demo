import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/flags - two live.flag values
// (banner {enabled, text}, dark-launch {enabled, rolloutPct}) set through
// the setFlag RPC and pushed to every subscriber. Drives every interactive
// element (both toggles, the banner text input, the rollout slider) and
// asserts REAL outcomes: the user card re-rendering from server-pushed
// values, the exact cohort boundary (bucket < rolloutPct is strict), the
// server-side VALIDATION rejection surfacing in the operator card, the
// server-authoritative (non-optimistic) user-card render, cross-tab
// fan-out, and latest-value replay to fresh connects. Cross-replica
// behaviour lives in the .cluster.spec.js sibling.
//
// Flag values are GLOBAL shared state (single-entry replay buffer), so
// every test drives the operator card to an explicit known state before
// asserting the user card and restores what it changed on the way out
// (workers=1 serial keeps other specs from racing the flips).

const RUN = `e2e-${Date.now()}`

// Real hydration gate: the operator controls stay disabled until BOTH flag
// stores hold a server-pushed value; the loading hint disappears at that
// point. Reused after reloads, hence separate from open().
async function gate(page) {
	await expect(page.getByTestId('fl-loading')).toHaveCount(0, { timeout: 15_000 })
	await expect(page.getByTestId('fl-banner-toggle')).toBeEnabled()
	await expect(page.getByTestId('fl-dark-toggle')).toBeEnabled()
}

async function open(page) {
	await page.goto('/demos/flags')
	await waitForWS(page)
	await gate(page)
}

// The text input commits on change (blur / Enter).
async function setBannerText(page, text) {
	await page.getByTestId('fl-banner-text').fill(text)
	await page.getByTestId('fl-banner-text').press('Enter')
}

async function bucketOf(page) {
	const bucket = Number(await page.getByTestId('fl-bucket').textContent())
	expect(Number.isInteger(bucket)).toBe(true)
	expect(bucket).toBeGreaterThanOrEqual(0)
	expect(bucket).toBeLessThanOrEqual(99)
	return bucket
}

test.describe('/demos/flags', () => {
	// Flag state is GLOBAL and shared across these serial tests. Reset it to
	// the declared defaults after every test in a fresh context so a mid-test
	// failure cannot leak a flipped flag into the next test (or leave the
	// shared env flipped on abort). Best-effort: teardown never fails a test.
	test.afterEach(async ({ browser }) => {
		let ctx
		try {
			ctx = await browser.newContext()
			const page = await ctx.newPage()
			await open(page)
			await page.getByTestId('fl-banner-toggle').setChecked(false)
			await page.getByTestId('fl-dark-toggle').setChecked(false)
			await page.getByTestId('fl-rollout').fill('0')
		} catch { /* best-effort teardown */ } finally {
			await ctx?.close().catch(() => {})
		}
	})

	test('hydrates: operator controls unlock, defaults render, the bucket is stable', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)

		await expect(page.getByTestId('fl-banner-text')).toBeEnabled()
		await expect(page.getByTestId('fl-rollout')).toBeEnabled()
		await expect(page.getByTestId('fl-op-error')).toHaveCount(0)
		await expect(page.getByTestId('fl-flag-error')).toHaveCount(0)

		// Drive to a known state (a shared-flag environment may not be at
		// the defaults), then assert the off-state user card.
		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await page.getByTestId('fl-dark-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-off')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })

		// The cohort bucket is a stable client-side hash of the identity id:
		// same identity, same bucket across a reload.
		const bucket = await bucketOf(page)
		await page.reload()
		await waitForWS(page)
		await gate(page)
		expect(await bucketOf(page)).toBe(bucket)
	})

	test('banner flag round-trips with typed text and re-renders live on edit', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		const original = await page.getByTestId('fl-banner-text').inputValue()

		// Type a unique text, then enable: the user card renders exactly it.
		const tag = `promo-${RUN}`
		await setBannerText(page, tag)
		await page.getByTestId('fl-banner-toggle').setChecked(true)
		await expect(page.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })
		await expect(page.getByTestId('fl-promo-off')).toHaveCount(0)

		// Edit the text while the banner is LIVE: the promo re-renders from
		// the newly pushed value, not from a stale first render.
		const tag2 = `promo2-${RUN}`
		await setBannerText(page, tag2)
		await expect(page.getByTestId('fl-promo-banner')).toContainText(tag2, { timeout: 10_000 })

		// Disable: back to the placeholder, and the whole cycle surfaced no
		// operator or subscribe error.
		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
		await expect(page.getByTestId('fl-promo-off')).toBeVisible()
		await expect(page.getByTestId('fl-op-error')).toHaveCount(0)
		await expect(page.getByTestId('fl-flag-error')).toHaveCount(0)

		await setBannerText(page, original)
	})

	test('whitespace-only banner text is rejected server-side; the pushed value survives', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		const original = await page.getByTestId('fl-banner-text').inputValue()

		const tag = `valid-${RUN}`
		await setBannerText(page, tag)
		await page.getByTestId('fl-banner-toggle').setChecked(true)
		await expect(page.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })

		// The client sends the draft as-is; the server trims, finds it empty,
		// and rejects with VALIDATION - nothing is published.
		await setBannerText(page, '   ')
		await expect(page.getByTestId('fl-op-error')).toContainText('VALIDATION', { timeout: 10_000 })
		// The rejected commit changed nothing: the promo still shows the old
		// text (the draft input keeps the whitespace - drafts only resync
		// from pushed values, and none arrived).
		await expect(page.getByTestId('fl-promo-banner')).toContainText(tag)

		// A valid commit recovers and clears the error.
		const tag2 = `valid2-${RUN}`
		await setBannerText(page, tag2)
		await expect(page.getByTestId('fl-promo-banner')).toContainText(tag2, { timeout: 10_000 })
		await expect(page.getByTestId('fl-op-error')).toHaveCount(0)

		await setBannerText(page, original)
		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
	})

	test('rollout slider gates the checkout tile at the exact cohort boundary', async ({ page }) => {
		test.setTimeout(45_000)
		await open(page)
		const bucket = await bucketOf(page)

		await page.getByTestId('fl-dark-toggle').setChecked(true)

		// 100 includes every bucket: drive the tile to New first, so the
		// strict-boundary assertion below is a real transition, not a stale read.
		await page.getByTestId('fl-rollout').fill('100')
		await expect(page.getByTestId('fl-rollout-value')).toHaveText('100%')
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('New checkout', { timeout: 10_000 })

		// The boundary is STRICT (bucket < rolloutPct). Coming DOWN from an
		// including rollout, a rollout equal to this identity's own bucket must
		// flip the tile back: New -> Old. This assertion WAITS for the excluded
		// value to render, so it actually discriminates the comparison - a <=
		// bug keeps the tile New and times out here. (Asserting Old from a
		// stale lower rollout, as an approach from below would, passes instantly
		// without ever proving exclusion.)
		await page.getByTestId('fl-rollout').fill(String(bucket))
		await expect(page.getByTestId('fl-rollout-value')).toHaveText(`${bucket}%`)
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })

		// ...and one percent more includes it again: Old -> New. The two
		// transitions together pin bucket < rolloutPct exactly, which 0/100
		// alone cannot.
		await page.getByTestId('fl-rollout').fill(String(bucket + 1))
		await expect(page.getByTestId('fl-rollout-value')).toHaveText(`${bucket + 1}%`)
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('New checkout', { timeout: 10_000 })

		// 0 includes none: New -> Old extreme (also restores the rollout).
		await page.getByTestId('fl-rollout').fill('0')
		await expect(page.getByTestId('fl-rollout-value')).toHaveText('0%')
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })

		await expect(page.getByTestId('fl-op-error')).toHaveCount(0)
		await expect(page.getByTestId('fl-flag-error')).toHaveCount(0)

		// Restore: launch off (rollout already 0).
		await page.getByTestId('fl-dark-toggle').setChecked(false)
		await expect(page.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })
	})

	test('the user card is server-authoritative: no render before the pushed value arrives', async ({ page }) => {
		test.setTimeout(45_000)
		// Delay every server->client frame. Flag commits are NOT optimistic:
		// the operator draft flips instantly (local state), but the user card
		// renders only from the server-pushed value, so the promo must NOT
		// appear inside the delay window.
		const SERVER_DELAY = 1_500
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => { setTimeout(() => ws.send(m), SERVER_DELAY) })
		})
		await open(page)
		await expect(page.getByTestId('fl-promo-off')).toBeVisible()

		await page.getByTestId('fl-banner-toggle').setChecked(true)
		// The draft checkbox is on immediately...
		await expect(page.getByTestId('fl-banner-toggle')).toBeChecked()
		// ...but sampling well inside the delay window, the user card still
		// shows no promo: nothing rendered ahead of the server.
		await page.waitForTimeout(SERVER_DELAY / 2)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0)
		// Once the delayed push lands, the promo renders.
		await expect(page.getByTestId('fl-promo-banner')).toBeVisible({ timeout: 3 * SERVER_DELAY })

		await page.getByTestId('fl-banner-toggle').setChecked(false)
		await expect(page.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 3 * SERVER_DELAY })
	})

	test('a flip in one tab lands live in the other, in both directions', async ({ browser }) => {
		test.setTimeout(45_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const original = await a.getByTestId('fl-banner-text').inputValue()

			const tag = `xtab-${RUN}`
			await setBannerText(a, tag)
			await a.getByTestId('fl-banner-toggle').setChecked(true)

			// B took no action: its USER card renders the tagged promo...
			await expect(b.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })
			// ...and its OPERATOR drafts resync from the pushed value too.
			await expect(b.getByTestId('fl-banner-toggle')).toBeChecked()
			await expect(b.getByTestId('fl-banner-text')).toHaveValue(tag)

			// Reverse direction: B flips it off, A follows.
			await b.getByTestId('fl-banner-toggle').setChecked(false)
			await expect(a.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
			await expect(a.getByTestId('fl-banner-toggle')).not.toBeChecked()

			await setBannerText(a, original)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a fresh connect is served the latest value: replay, not just live push', async ({ browser }) => {
		test.setTimeout(45_000)
		const ctxA = await browser.newContext()
		const a = await ctxA.newPage()
		try {
			await open(a)
			const original = await a.getByTestId('fl-banner-text').inputValue()

			const tag = `replay-${RUN}`
			await setBannerText(a, tag)
			await a.getByTestId('fl-banner-toggle').setChecked(true)
			await expect(a.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })

			// A brand-new context connects AFTER the set. It missed the live
			// push, so the promo it renders can only come from the replayed
			// latest value.
			const ctxB = await browser.newContext()
			try {
				const b = await ctxB.newPage()
				await open(b)
				await expect(b.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })
				await expect(b.getByTestId('fl-banner-toggle')).toBeChecked()
			} finally {
				await ctxB.close()
			}

			await setBannerText(a, original)
			await a.getByTestId('fl-banner-toggle').setChecked(false)
			await expect(a.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
		} finally {
			await ctxA.close()
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			// The toggle's tap surface is its wrapping label, not the widget.
			await expectTouchTarget(page.getByTestId('fl-banner-toggle').locator('..'))
			await expectTouchTarget(page.getByTestId('fl-dark-toggle').locator('..'))
			await expectTouchTarget(page.getByTestId('fl-banner-text'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('fl-rollout'), { minWidth: 0 })
		} finally {
			await context.close()
		}
	})
})
