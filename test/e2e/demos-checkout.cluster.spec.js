import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/checkout: the order counter is a single
// cluster-shared Redis key published over the bus, so an order placed on
// replica A must be reflected for a subscriber on replica B. Runs in the
// cluster tier (two instances + INSTANCE_B); skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/checkout`)
	await waitForWS(page)
	// Gate on real stream hydration, not the "0" fallback (see demos-checkout.spec.js).
	await expect(page.getByTestId('checkout-count')).toHaveAttribute('data-hydrated', 'true', { timeout: 10_000 })
}

test.describe('cluster: /demos/checkout cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('an order placed on replica A is reflected on replica B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// Reset from A and confirm B sees zero (shared key + fan-out).
			await a.getByTestId('checkout-reset').click()
			await expect(a.getByTestId('checkout-count')).toHaveText('0', { timeout: 10_000 })
			await expect(b.getByTestId('checkout-count')).toHaveText('0', { timeout: 15_000 })

			// Order on A; B's counter increments via the cross-replica relay.
			await a.getByTestId('checkout-place').click()
			await expect(b.getByTestId('checkout-count')).toHaveText('1', { timeout: 15_000 })

			// Order on B; A sees it too - the counter is authoritative in Redis.
			await b.getByTestId('checkout-place').click()
			await expect(a.getByTestId('checkout-count')).toHaveText('2', { timeout: 15_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
