import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/ops', () => {
	test('snapshot cards render live numbers without console errors', async ({ page }) => {
		const errors = []
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(msg.text())
		})
		page.on('pageerror', (err) => {
			errors.push(err.message)
		})

		await page.goto('/demos/ops')
		await waitForWS(page)

		// Our own WS connection counts, so the transport card must reach
		// at least 1 once the first poll after connect lands.
		await expect.poll(
			async () => Number(await page.getByTestId('ops-connections').textContent()),
			{ timeout: 15_000 }
		).toBeGreaterThanOrEqual(1)

		// Counts-only snapshot fields render as plain integers.
		await expect(page.getByTestId('ops-inflight')).toHaveText(/^\d+$/)
		await expect(page.getByTestId('ops-topics-active')).toHaveText(/^\d+$/)
		await expect(page.getByTestId('ops-topics-subscribers')).toHaveText(/^\d+$/)
		await expect(page.getByTestId('ops-handlers-total')).toHaveText(/^\d+$/)

		// The gallery registers plenty of handlers; the by-kind breakdown
		// must be populated, not stuck on the loading placeholder.
		await expect.poll(
			async () => Number(await page.getByTestId('ops-handlers-total').textContent()),
			{ timeout: 10_000 }
		).toBeGreaterThan(0)
		await expect(page.getByTestId('ops-handlers-kinds')).toBeVisible()

		// The snapshot stamps which worker answered (leader.instanceId), so the
		// per-process counts that swing on a multi-replica deploy stay
		// self-explanatory. The leader facade is active once Redis infra
		// initialised (the id is generated locally, independent of Redis
		// connectivity), so a single-instance run still shows one stable id.
		const replica = page.getByTestId('ops-replica')
		await expect(replica).toContainText('reading replica', { timeout: 15_000 })
		await expect(replica.locator('[data-instance-id]')).toHaveAttribute(
			'data-instance-id',
			/^[0-9a-f]{6,}$/
		)

		expect(errors).toHaveLength(0)
	})

	test('DLQ summary and admin-plane cards render', async ({ page }) => {
		await page.goto('/demos/ops')
		await waitForWS(page)

		// Zero is a perfectly healthy DLQ; the card just has to resolve
		// to a number rather than stay blank.
		await expect(page.getByTestId('ops-dlq-card')).toBeVisible()
		await expect(page.getByTestId('ops-dlq-total')).toHaveText(/^\d+$/, { timeout: 15_000 })

		// The admin-plane note ships a placeholder bearer token, never a
		// real one.
		await expect(page.getByTestId('ops-curl')).toContainText('Authorization: Bearer $ADMIN_TOKEN')
		await expect(page.getByTestId('ops-curl')).toContainText('/__realtime/introspect')
	})
})
