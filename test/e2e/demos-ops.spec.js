import { test, expect } from '@playwright/test'
import {
	dlqState,
	expectDlqConsistent,
	handlerKinds,
	integer,
	openOps,
	replicaId
} from './ops-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/ops', () => {
	test('renders the complete counts-only dashboard with internally consistent metrics and no errors', async ({ page }) => {
		const errors = []
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text())
		})
		page.on('pageerror', (error) => errors.push(error.message))
		await openOps(page)

		for (const id of [
			'ops-headline-card',
			'ops-handlers-card',
			'ops-machinery-card',
			'ops-pressure-card',
			'ops-dlq-card',
			'ops-admin-card'
		]) await expect(page.getByTestId(id)).toBeVisible()

		const headlineIds = ['ops-connections', 'ops-inflight', 'ops-topics-active', 'ops-topics-subscribers']
		for (const id of headlineIds) {
			await expect(page.getByTestId(id)).toHaveText(/^\d+$/)
			expect(await integer(page, id)).toBeGreaterThanOrEqual(0)
		}
		expect(await integer(page, 'ops-connections')).toBeGreaterThanOrEqual(1)

		const kinds = await handlerKinds(page)
		expect(Object.keys(kinds).length).toBeGreaterThan(0)
		expect(Object.values(kinds).reduce((sum, count) => sum + count, 0))
			.toBe(await integer(page, 'ops-handlers-total'))
		await expect(page.getByTestId('ops-handlers-modifiers')).toHaveText(
			/modifiers: deprecated \d+\s*\/\s*rate-limited \d+\s*\/\s*idempotent \d+\s*\/\s*volatile \d+/
		)

		for (const id of ['ops-push-users', 'ops-push-sessions', 'ops-watched-topics', 'ops-rate-buckets']) {
			await expect(page.getByTestId(id)).toHaveText(/^\d+$/)
		}
		await expect(page.getByTestId('ops-cron')).toHaveText(/^\d+ \(\d+\)$/)
		await expect(page.getByTestId('ops-reactive')).toHaveText(/^\d+ \/ \d+ \/ \d+$/)
		await expect(page.getByTestId('ops-wired')).toHaveText('yes / yes')

		// The pressure card is absent only where the adapter reports no snapshot
		// (vite dev). Against a real server it must be present, so the branch is
		// pinned to the environment rather than to the page: otherwise a
		// regression that stops rendering the card silently downgrades this test
		// to the trivial arm and keeps reporting green.
		const pressureCard = await page.getByTestId('ops-pressure-reason').count()
		if (process.env.LOCAL_E2E === '1' || process.env.CI) expect(pressureCard).toBeGreaterThan(0)
		if (pressureCard > 0) {
			await expect(page.getByTestId('ops-pressure-reason')).toHaveText(/^(NONE|MEMORY|PUBLISH_RATE|SUBSCRIBERS)$/)
			const pressure = Number(await page.getByTestId('ops-pressure-value').getAttribute('value'))
			expect(pressure).toBeGreaterThanOrEqual(0)
			expect(pressure).toBeLessThanOrEqual(1)
			await expect(page.getByTestId('ops-protection')).not.toHaveText('-')
			await expect(page.getByTestId('ops-publish-rate')).toHaveText(/^\d+$/)
			await expect(page.getByTestId('ops-memory-mb')).toHaveText(/^\d+$/)
		} else {
			await expect(page.getByTestId('ops-pressure-missing')).toBeVisible()
		}

		await replicaId(page)
		await expect(page.getByTestId('ops-replica-note')).toContainText("one worker's local counts")
		await expectDlqConsistent(page)
		await expect(page.getByTestId('ops-curl')).toContainText('Authorization: Bearer $ADMIN_TOKEN')
		await expect(page.getByTestId('ops-curl')).toContainText('/__realtime/introspect')
		await expect(page.getByTestId('ops-error')).toHaveCount(0)
		expect(errors).toHaveLength(0)
	})

	test('the 3-second poll pauses while hidden and refreshes immediately when visible again', async ({ page }) => {
		await openOps(page)
		const refreshed = page.getByTestId('ops-refreshed-at')
		const initial = await refreshed.textContent()
		await expect.poll(() => refreshed.textContent(), { timeout: 5_000 }).not.toBe(initial)

		await page.evaluate(() => {
			window.__opsE2EVisibility = 'hidden'
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => window.__opsE2EVisibility
			})
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await page.waitForTimeout(300)
		const hiddenAt = await refreshed.textContent()
		await page.waitForTimeout(3_500)
		expect(await refreshed.textContent()).toBe(hiddenAt)

		await page.evaluate(() => {
			window.__opsE2EVisibility = 'visible'
			document.dispatchEvent(new Event('visibilitychange'))
		})
		await expect.poll(() => refreshed.textContent(), { timeout: 5_000 }).not.toBe(hiddenAt)
	})

	test('two tabs expose their answering replicas and local connection counts without treating variance as drift', async ({ page, context }) => {
		await openOps(page)
		const other = await context.newPage()
		try {
			await openOps(other)
			const [replicaA, replicaB] = await Promise.all([replicaId(page), replicaId(other)])
			for (const current of [page, other]) {
				expect(await integer(current, 'ops-connections')).toBeGreaterThanOrEqual(1)
				await expect(current.getByTestId('ops-replica-note')).toBeVisible()
			}
			if (replicaA === replicaB) {
				await expect.poll(() => integer(page, 'ops-connections'), { timeout: 5_000 }).toBeGreaterThanOrEqual(2)
				await expect.poll(() => integer(other, 'ops-connections'), { timeout: 5_000 }).toBeGreaterThanOrEqual(2)
			}
		} finally {
			await other.close()
		}
	})

	test('the DLQ workbench link navigates out and browser Back restores the live dashboard', async ({ page }) => {
		await openOps(page)
		const source = page.getByRole('link', { name: 'ops.js' })
		await expect(source).toHaveAttribute('href', /src\/live\/demos\/ops\.js$/)
		const workbench = page.getByTestId('ops-dlq-card').getByRole('link', { name: '/demos/outbound-webhooks' })
		await expect(workbench).toHaveAttribute('href', '/demos/outbound-webhooks')
		await workbench.click()
		await expect(page).toHaveURL(/\/demos\/outbound-webhooks$/)
		await expect(page.getByTestId('ow-controls-card')).toBeVisible()
		await page.goBack()
		await openOps(page, page.url())
		await expectDlqConsistent(page)
		const state = await dlqState(page)
		expect(state.total).toBeGreaterThanOrEqual(0)
	})
})
