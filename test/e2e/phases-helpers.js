import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openPhases(page, url = '/demos/phases') {
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })
}

export async function feedRows(page) {
	return page.getByTestId('ph-feed-row').evaluateAll((rows) => rows.map((row) => {
		const spans = row.querySelectorAll('span')
		return {
			half: spans[1]?.textContent?.trim() ?? '',
			label: spans[2]?.textContent?.trim() ?? '',
			id: spans[3]?.textContent?.trim() ?? ''
		}
	}))
}

export async function publishPair(page) {
	await page.getByTestId('ph-publish-pair').click()
	await expect(page.getByTestId('ph-last-pair')).toBeVisible({ timeout: 10_000 })
	const text = await page.getByTestId('ph-last-pair').textContent()
	const match = text?.match(/published\s+([0-9a-f]{8})\s*\+\s*([0-9a-f]{8})/)
	expect(match).toBeTruthy()
	return [match?.[1] ?? '', match?.[2] ?? '']
}

export async function waitForPair(page, ids) {
	for (const id of ids) {
		await expect(page.getByTestId('ph-feed-row').filter({ hasText: id })).toHaveCount(1, { timeout: 10_000 })
	}
	const rows = await feedRows(page)
	return ids.map((id) => rows.find((row) => row.id === id))
}

export async function detach(page) {
	await page.getByTestId('ph-detach').click()
	await expect(page.getByTestId('ph-phase')).toHaveText('detached', { timeout: 5_000 })
}

export async function attach(page) {
	await page.getByTestId('ph-attach').click()
	await expect(page.getByTestId('ph-phase')).toHaveText('attached', { timeout: 10_000 })
}
