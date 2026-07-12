import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/phases', () => {
	test('feed attaches on mount and the phase badge reflects it', async ({ page }) => {
		await page.goto('/demos/phases')
		await waitForWS(page)

		await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })
		await expect(page.getByTestId('ph-feed')).toBeVisible()
	})

	test('detach hides the feed; attach brings it back', async ({ page }) => {
		await page.goto('/demos/phases')
		await waitForWS(page)
		await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })

		await page.getByTestId('ph-detach').click()
		await expect(page.getByTestId('ph-phase')).toHaveText('detached', { timeout: 5_000 })
		await expect(page.getByTestId('ph-feed')).toHaveCount(0)
		await expect(page.getByTestId('ph-feed-hidden')).toBeVisible()

		await page.getByTestId('ph-attach').click()
		await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })
		await expect(page.getByTestId('ph-feed')).toBeVisible()
	})

	test('publish pair lands two entries; fail-midway lands neither', async ({ page }) => {
		await page.goto('/demos/phases')
		await waitForWS(page)
		await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })

		const countOf = async () => Number(await page.getByTestId('ph-feed-count').textContent())
		const before = await countOf()

		// The happy path flushes both buffered publishes together. The
		// feed is capped at 10 server-side (evictions publish 'deleted'),
		// so assert the pair is VISIBLE rather than a raw +2 on the count.
		await page.getByTestId('ph-publish-pair').click()
		await expect(page.getByTestId('ph-last-pair')).toBeVisible({ timeout: 10_000 })
		const pairText = await page.getByTestId('ph-last-pair').textContent()
		const pairMatch = pairText?.match(/published\s+([0-9a-f]{8})\s*\+\s*([0-9a-f]{8})/)
		expect(pairMatch).toBeTruthy()
		for (const id of [pairMatch?.[1] ?? '', pairMatch?.[2] ?? '']) {
			await expect(page.getByTestId('ph-feed-row').filter({ hasText: id }).first()).toBeVisible({ timeout: 10_000 })
		}

		// The failing variant throws between the two buffered publishes,
		// across an await boundary: the error surfaces and NOTHING lands.
		const midCount = await countOf()
		await page.getByTestId('ph-publish-fail').click()
		await expect(page.getByTestId('ph-batch-error')).toContainText('VALIDATION', { timeout: 10_000 })
		// Give a would-be stray publish time to arrive before asserting.
		await page.waitForTimeout(1_500)
		expect(await countOf()).toBe(midCount)
		expect(before).toBeLessThanOrEqual(midCount)
	})
})
