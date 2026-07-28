import { test, expect } from '@playwright/test'
import {
	attach,
	detach,
	feedRows,
	openPhases,
	publishPair,
	waitForPair
} from './phases-helpers.js'

test.describe('/demos/phases', () => {
	test('renders the complete lifecycle, atomic-batch controls, disclosure, and source link', async ({ page }) => {
		await openPhases(page)
		await expect(page.getByRole('heading', { name: 'Phases: attach lifecycle + atomic publish batch' })).toBeVisible()
		await expect(page.getByTestId('ph-lifecycle-card')).toBeVisible()
		await expect(page.getByTestId('ph-batch-card')).toBeVisible()
		await expect(page.getByTestId('ph-attach')).toBeVisible()
		await expect(page.getByTestId('ph-attach')).toBeDisabled()
		await expect(page.getByTestId('ph-detach')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-fail')).toBeEnabled()
		await expect(page.getByText('initialized -> attaching -> attached -> detached | failed', { exact: false })).toBeVisible()
		await expect(page.getByText('Both buttons run the same handler:', { exact: false })).toBeVisible()
		await expect(page.getByRole('link', { name: 'phases.js' })).toHaveAttribute(
			'href',
			/src\/live\/demos\/phases\.js$/
		)
		await expect(page.getByTestId('ph-attach-error')).toHaveCount(0)
		await expect(page.getByTestId('ph-batch-error')).toHaveCount(0)
		const count = Number(await page.getByTestId('ph-feed-count').textContent())
		expect(count).toBe(await page.getByTestId('ph-feed-row').count())
		expect(count).toBeLessThanOrEqual(10)
	})

	test('detach hides and releases the feed, while attach reloads work published during detachment', async ({ page }) => {
		await openPhases(page)
		await detach(page)
		await expect(page.getByTestId('ph-feed')).toHaveCount(0)
		await expect(page.getByTestId('ph-feed-hidden')).toContainText('subscription is detached')
		await expect(page.getByTestId('ph-attach')).toBeEnabled()
		await expect(page.getByTestId('ph-detach')).toBeDisabled()

		const ids = await publishPair(page)
		await expect(page.getByTestId('ph-feed')).toHaveCount(0)
		await attach(page)
		await expect(page.getByTestId('ph-attach')).toBeDisabled()
		await expect(page.getByTestId('ph-detach')).toBeEnabled()
		await waitForPair(page, ids)
	})

	test('Publish pair flushes two ordered, identifiable entries atomically', async ({ page }) => {
		await openPhases(page)
		const ids = await publishPair(page)
		expect(new Set(ids).size).toBe(2)
		const pair = await waitForPair(page, ids)
		expect(pair).toEqual([
			{ half: 'first', label: 'first half', id: ids[0] },
			{ half: 'second', label: 'second half', id: ids[1] }
		])
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-fail')).toBeEnabled()
	})

	test('Fail midway surfaces validation, publishes nothing, and clears on the next successful action', async ({ page }) => {
		await openPhases(page)
		const before = await feedRows(page)
		await page.getByTestId('ph-publish-fail').click()
		await expect(page.getByTestId('ph-batch-error')).toContainText('VALIDATION: midway failure - nothing above was published')
		await page.waitForTimeout(1_500)
		expect(await feedRows(page)).toEqual(before)
		await expect(page.getByTestId('ph-last-pair')).toHaveCount(0)
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()

		const ids = await publishPair(page)
		await expect(page.getByTestId('ph-batch-error')).toHaveCount(0)
		await waitForPair(page, ids)
	})
})
