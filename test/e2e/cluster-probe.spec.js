/**
 * Cluster-correctness probe. Verifies that state mutated on instance A
 * is visible to a subscriber on instance B - exercising the actual
 * cluster path that the production deploy uses (shared Redis + bus
 * fan-out). Not run as part of the default suite; invoke with:
 *
 *   BASE_URL=http://localhost:3091 INSTANCE_B=http://localhost:3092 \
 *     npx playwright test e2e/cluster-probe.spec.js
 *
 * Requires two app instances running against the same Redis + Postgres.
 */

import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

// These tests require two distinct instances against the same Redis +
// Postgres. Without a real INSTANCE_B (e.g. when the suite runs against
// the single-URL production deploy), the localhost:3092 fallback yields
// ERR_CONNECTION_REFUSED on every navigation. Skip rather than fail; run
// locally with both ports set to actually exercise the cluster relay.
test.skip(
	!process.env.INSTANCE_B,
	'cluster-probe requires INSTANCE_B set (two local instances against shared Redis/Postgres)'
)

test.describe('cluster: cross-instance state propagation', () => {
	test('todos: add on A is visible on B (loader read + live event)', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/todos-rollback`)
			await b.goto(`${INSTANCE_B}/demos/todos-rollback`)

			// Ensure both pages have populated their loaders.
			await expect(a.getByTestId('todos')).toBeVisible({ timeout: 8_000 })
			await expect(b.getByTestId('todos')).toBeVisible({ timeout: 8_000 })

			const text = `cluster-${Date.now()}`
			await a.getByTestId('todo-input').fill(text)
			await a.getByTestId('add-button').click()

			// A sees its own add (local fan-out).
			await expect(a.getByTestId('todos')).toContainText(text, { timeout: 5_000 })
			// B sees the add via Redis bus fan-out from A's instance.
			await expect(b.getByTestId('todos')).toContainText(text, { timeout: 5_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('checkout: order count visible to subscriber on B after place on A', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/checkout`)
			await b.goto(`${INSTANCE_B}/demos/checkout`)

			const countA = a.locator('.tabular-nums').first()
			const countB = b.locator('.tabular-nums').first()
			await expect(countA).toBeVisible({ timeout: 8_000 })
			await expect(countB).toBeVisible({ timeout: 8_000 })

			// Reset on A so both instances start from a known baseline.
			await a.getByRole('button', { name: 'Reset' }).click()
			await expect(countA).toHaveText('0', { timeout: 5_000 })
			await expect(countB).toHaveText('0', { timeout: 5_000 })

			await a.getByRole('button', { name: 'Place Order', exact: true }).click()
			await expect(countA).toHaveText('1', { timeout: 5_000 })
			// The cluster-correct fix: B's subscriber sees the value via the
			// 'set' event fan-out from A's instance through Redis pub/sub.
			await expect(countB).toHaveText('1', { timeout: 5_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('cluster-cron: leader-only tick is visible on both replicas', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/cluster-cron`)
			await b.goto(`${INSTANCE_B}/demos/cluster-cron`)

			// Both pages should see ticks from the leader (whichever replica
			// holds the lease) within a few seconds. Pre-fix, only the leader's
			// subscribers saw ticks via the loader; non-leader replicas had
			// empty recentTicks. Post-fix, both replicas read from the shared
			// Redis LIST so both render the same tick history.
			await expect(a.locator('[data-testid="cluster-cron-tick-row"]').first()).toBeVisible({ timeout: 10_000 })
			await expect(b.locator('[data-testid="cluster-cron-tick-row"]').first()).toBeVisible({ timeout: 10_000 })

			const countA = await a.locator('[data-testid="cluster-cron-tick-row"]').count()
			const countB = await b.locator('[data-testid="cluster-cron-tick-row"]').count()
			// Within a few seconds both should have similar counts (cluster
			// pub/sub delivers each tick to both subscriber sets).
			expect(Math.abs(countA - countB)).toBeLessThanOrEqual(2)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
