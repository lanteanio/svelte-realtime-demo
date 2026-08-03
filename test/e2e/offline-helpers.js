import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openOffline(page, url = '/demos/offline') {
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 10_000 })
}

export async function postEntry(page, text, submitWithEnter = false) {
	const input = page.getByTestId('off-input')
	await input.fill(text)
	await expect(page.getByTestId('off-post-button')).toBeEnabled()
	if (submitWithEnter) await input.press('Enter')
	else await page.getByTestId('off-post-button').click()
	await expect(input).toHaveValue('')
}

/**
 * Rows the SERVER has confirmed. Scoped to `li[data-entry]` deliberately:
 * the list also carries ghosted `li[data-queued]` rows for posts this tab
 * has handed to the offline queue, and an unscoped `li` match would let
 * `waitExactlyOnce` be satisfied by a local echo that never reached the
 * server - quietly turning the demo's central guarantee into a check that
 * the page can render its own optimism.
 */
export function entryRows(page, text) {
	return page.getByTestId('off-entries').locator('li[data-entry]', { hasText: text })
}

/** Ghost rows for mutations still sitting in the queue. */
export function queuedRows(page, text) {
	return page.getByTestId('off-entries').locator('li[data-queued]', { hasText: text })
}

export async function waitExactlyOnce(page, text) {
	await expect(entryRows(page, text)).toHaveCount(1, { timeout: 30_000 })
}

export async function pendingCount(page) {
	return Number(await page.getByTestId('off-pending-count').textContent())
}

export async function checkpointSeq(page) {
	return Number(await page.getByTestId('off-checkpoint-seq').textContent())
}

export async function simulateOffline(page) {
	await page.getByTestId('off-sim-toggle').click()
	await expect(page.getByTestId('off-sim-badge')).toBeVisible()
	await expect(page.getByTestId('off-sim-toggle')).toHaveText('Reconnect')
	await expect(page.locator('.text-success')).toHaveCount(0, { timeout: 30_000 })
}

export async function reconnect(page) {
	await page.getByTestId('off-sim-toggle').click()
	await expect(page.getByTestId('off-sim-toggle')).toHaveText('Go offline')
	await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 60_000 })
}
