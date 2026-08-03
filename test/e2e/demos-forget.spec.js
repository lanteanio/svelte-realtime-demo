import { test, expect } from '@playwright/test'
import {
	auditTraces,
	displayedIdentity,
	forget,
	leaveTraces,
	openForget
} from './forget-helpers.js'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/forget', () => {
	test('renders all three ordered steps, identity context, controls, disclosure, and source link', async ({ page }) => {
		await openForget(page)
		await expect(page.getByRole('heading', { name: 'Right to erasure:' })).toBeVisible()
		for (const [section, heading, control] of [
			['fg-traces-section', '1. Leave traces', 'fg-leave-traces'],
			['fg-audit-section', '2. Audit (app-side)', 'fg-audit'],
			['fg-forget-section', '3. Forget me', 'fg-forget']
		]) {
			await expect(page.getByTestId(section).getByRole('heading', { name: heading })).toBeVisible()
			await expect(page.getByTestId(control)).toBeVisible()
			await expect(page.getByTestId(control)).toBeEnabled()
		}
		expect(await displayedIdentity(page)).toMatch(/You are .+ \([0-9a-f]{8}\) - the identity that gets erased below\./i)
		await expect(page.getByText('erases you', { exact: false })).toBeVisible()
		await expect(page.getByRole('link', { name: 'forget.js' })).toHaveAttribute('href', /src\/live\/demos\/forget\.js$/)
	})

	test('repeated writes add three traces each, while the idempotent draft result is reused', async ({ page }) => {
		await openForget(page)
		await forget(page)
		const first = await leaveTraces(page)
		expect(first.added).toBe(3)
		expect(first.total).toBe(3)
		await new Promise((resolve) => setTimeout(resolve, 1_100))
		const second = await leaveTraces(page)
		expect(second.added).toBe(3)
		expect(second.total).toBe(6)
		expect(second.draft).toBe(first.draft)
		await auditTraces(page, 6)
		await forget(page, 6)
	})

	test('forget conserves the surface counts, clears app data, and permits fresh use on the same connection', async ({ page }) => {
		await openForget(page)
		await forget(page)
		const identity = await displayedIdentity(page)
		const before = await leaveTraces(page)
		await auditTraces(page, 3)
		const result = await forget(page, 3)

		expect(result.counts.appDemoLog).toBe(3)
		expect(result.rowsAffected).toBeGreaterThanOrEqual(3)
		await expect(page.getByTestId('fg-traces-result')).toHaveCount(0)
		await expect(page.getByTestId('fg-audit-applog')).toHaveText('0')
		await auditTraces(page, 0)
		expect(await displayedIdentity(page)).toBe(identity)
		await waitForWS(page)

		await new Promise((resolve) => setTimeout(resolve, 1_100))
		const after = await leaveTraces(page)
		expect(after.added).toBe(3)
		expect(after.total).toBe(3)
		expect(after.draft).not.toBe(before.draft)
		await auditTraces(page, 3)
		await forget(page, 3)
	})

	test('two tabs share one identity: remote writes audit together, erasure clears both, and new traces accrue', async ({ page, context }) => {
		await openForget(page)
		await forget(page)
		const other = await context.newPage()
		try {
			await openForget(other)
			expect(await displayedIdentity(other)).toBe(await displayedIdentity(page))
			const traces = await leaveTraces(other)
			expect(traces.total).toBe(3)
			await auditTraces(page, 3)

			await forget(page, 3)
			await auditTraces(other, 0)
			await waitForWS(other)
			const fresh = await leaveTraces(other)
			expect(fresh.total).toBe(3)
			await auditTraces(page, 3)
		} finally {
			await forget(page, 3)
			await other.close()
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openForget(page)
			// Measure only; Forget me is behind a confirm dialog and must not be clicked here.
			await expectTouchTarget(page.getByTestId('fg-leave-traces'))
			await expectTouchTarget(page.getByTestId('fg-audit'))
			await expectTouchTarget(page.getByTestId('fg-forget'))
		} finally {
			await context.close()
		}
	})
})
