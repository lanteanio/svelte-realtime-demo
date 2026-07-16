import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/flags: two tabs forced onto DIFFERENT
// SO_REUSEPORT replicas (instance A vs instance B) against shared Redis +
// Postgres. Flags claim cluster consistency by default (a single-entry
// SHARED replay buffer), and this tier proves the two halves the
// single-instance suite cannot see:
//   1. A .set() handled on replica A relays over the cross-replica bus and
//      re-renders an already-subscribed client on replica B live (user card
//      AND operator drafts), in both directions.
//   2. A client that connects FRESH to replica B - which never handled the
//      set - is served the cluster-latest value from the shared buffer.
//   3. The relayed value composes with B's own client-side cohort logic:
//      a rollout set on A gates B's checkout tile at B's own strict bucket
//      boundary.
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

const RUN = `cluster-${Date.now()}`

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/flags`)
	await waitForWS(page)
	// Real hydration gate: operator controls stay disabled until both flag
	// stores hold a server-pushed value.
	await expect(page.getByTestId('fl-loading')).toHaveCount(0, { timeout: 15_000 })
	await expect(page.getByTestId('fl-banner-toggle')).toBeEnabled()
	await expect(page.getByTestId('fl-dark-toggle')).toBeEnabled()
}

// The text input commits on change (blur / Enter).
async function setBannerText(page, text) {
	await page.getByTestId('fl-banner-text').fill(text)
	await page.getByTestId('fl-banner-text').press('Enter')
}

test.describe('cluster: /demos/flags cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	// Reset the shared flag state after each cross-replica test via a fresh
	// context on A - the single-entry buffer relays the reset to every replica
	// - so a mid-test failure cannot leak a flipped flag into the next test.
	// Best-effort: teardown never fails a test.
	test.afterEach(async ({ browser }) => {
		if (!process.env.INSTANCE_B) return
		let ctx
		try {
			ctx = await browser.newContext({ baseURL: INSTANCE_A })
			const page = await ctx.newPage()
			await openAt(page, INSTANCE_A)
			await page.getByTestId('fl-banner-toggle').setChecked(false)
			await page.getByTestId('fl-dark-toggle').setChecked(false)
			await page.getByTestId('fl-rollout').fill('0')
		} catch { /* best-effort teardown */ } finally {
			await ctx?.close().catch(() => {})
		}
	})

	test('a flag set on replica A re-renders a live subscriber on replica B, both directions', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			const original = await a.getByTestId('fl-banner-text').inputValue()

			const tag = `xreplica-${RUN}`
			await setBannerText(a, tag)
			await a.getByTestId('fl-banner-toggle').setChecked(true)

			// B never touched the form; the tagged promo can only arrive via
			// the cross-replica bus relay - and its operator drafts resync
			// from the same pushed value.
			await expect(b.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })
			await expect(b.getByTestId('fl-banner-toggle')).toBeChecked()
			await expect(b.getByTestId('fl-banner-text')).toHaveValue(tag)

			// Reverse direction: B flips it off, A follows over the same bus.
			await b.getByTestId('fl-banner-toggle').setChecked(false)
			await expect(a.getByTestId('fl-promo-banner')).toHaveCount(0, { timeout: 10_000 })
			await expect(a.getByTestId('fl-banner-toggle')).not.toBeChecked()

			await setBannerText(a, original)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a fresh connect to replica B is served the cluster-latest value set on A', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await ctxA.newPage()
		try {
			await openAt(a, INSTANCE_A)
			const original = await a.getByTestId('fl-banner-text').inputValue()

			const tag = `latest-${RUN}`
			await setBannerText(a, tag)
			await a.getByTestId('fl-banner-toggle').setChecked(true)
			await expect(a.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })

			// This context connects to B AFTER the set, so it missed the live
			// relay entirely. Replica B never handled the .set() - the promo
			// can only come from the SHARED single-entry replay buffer.
			const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
			try {
				const b = await ctxB.newPage()
				await openAt(b, INSTANCE_B)
				await expect(b.getByTestId('fl-promo-banner')).toContainText(tag, { timeout: 10_000 })
				await expect(b.getByTestId('fl-banner-toggle')).toBeChecked()
				await expect(b.getByTestId('fl-banner-text')).toHaveValue(tag)
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

	test('a rollout set on A gates the checkout tile on B at B\'s own bucket boundary', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// B's identity (a different context) has its own cohort bucket;
			// the flag VALUE relays from A while the bucketing stays local.
			const bucketB = Number(await b.getByTestId('fl-bucket').textContent())
			expect(Number.isInteger(bucketB)).toBe(true)
			expect(bucketB).toBeGreaterThanOrEqual(0)
			expect(bucketB).toBeLessThanOrEqual(99)

			await a.getByTestId('fl-dark-toggle').setChecked(true)
			// Strict boundary, driven entirely from the OTHER replica. Include B
			// first so the exclusion assertion is a real relayed transition: a
			// rollout of B's bucket + 1 flips B's tile Old -> New over the bus.
			await a.getByTestId('fl-rollout').fill(String(bucketB + 1))
			await expect(b.getByTestId('fl-checkout-tile')).toContainText('New checkout', { timeout: 10_000 })
			// ...and exactly B's bucket excludes B (strict bucket < rolloutPct):
			// the relayed value must flip B's tile back New -> Old. This WAITS
			// for the excluded value, so it discriminates the comparison on B -
			// a <= bug keeps B's tile New and times out here.
			await a.getByTestId('fl-rollout').fill(String(bucketB))
			await expect(b.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })

			await expect(b.getByTestId('fl-op-error')).toHaveCount(0)
			await expect(b.getByTestId('fl-flag-error')).toHaveCount(0)

			// Restore from B's side (exercises the reverse RPC path too).
			await b.getByTestId('fl-rollout').fill('0')
			await b.getByTestId('fl-dark-toggle').setChecked(false)
			await expect(a.getByTestId('fl-checkout-tile')).toContainText('Old checkout', { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
