import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openOutbound(page, target = '/demos/outbound-webhooks') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByTestId('ow-controls-card')).toBeVisible()
	await expect(page.getByTestId('ow-receipts-count')).toHaveText(/^\d+$/, { timeout: 10_000 })
	await expect(page.getByTestId('ow-dlq-count')).toHaveText(/^\d+$/, { timeout: 10_000 })
}

export async function placeOrder(page, mode) {
	const last = page.getByTestId('ow-last-order')
	const before = (await last.count()) > 0 ? await last.textContent() : null
	await page.getByTestId(mode === 'fail' ? 'ow-place-fail' : 'ow-place-ok').click()
	await expect(last).toBeVisible({ timeout: 10_000 })
	await expect.poll(() => last.textContent(), { timeout: 10_000 }).not.toBe(before)
	const text = (await last.textContent()) ?? ''
	const shortId = text.match(/placed\s+(\w{8})/)?.[1]
	expect(shortId).toBeTruthy()
	expect(text).toContain(mode === 'fail' ? 'fail' : 'ok')
	return shortId
}

export function receiptRows(page, shortId) {
	return page.getByTestId('ow-receipt-row').filter({ hasText: shortId })
}

export async function waitForReceipts(page, shortId, minimum = 1, timeout = 20_000) {
	await expect.poll(() => receiptRows(page, shortId).count(), { timeout }).toBeGreaterThanOrEqual(minimum)
	return receiptRows(page, shortId).evaluateAll((rows) => rows.map((row) => ({
		text: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
		sigValid: Boolean(row.querySelector('[data-testid="ow-sig-valid"]')),
		idempotencyKey: row.querySelector('[data-testid="ow-idem-key"]')?.textContent?.trim() ?? ''
	})))
}

export function dlqRow(page, shortId) {
	return page.getByTestId('ow-dlq-row').filter({ hasText: shortId }).first()
}

export async function waitForDlq(page, shortId, timeout = 25_000) {
	const row = dlqRow(page, shortId)
	await expect(row).toBeVisible({ timeout })
	await expect(row).toContainText('attempts: 3')
	await expect(row).toContainText('fail')
	await expect(row).toContainText('HTTP 500')
	await expect(row.getByTestId('ow-replay')).toBeEnabled()
	return row
}

export async function dlqCount(page) {
	return Number(await page.getByTestId('ow-dlq-count').textContent())
}

async function replay(page, button) {
	const result = page.getByTestId('ow-replay-result')
	const before = (await result.count()) > 0 ? await result.textContent() : null
	await button.click()
	await expect(result).toBeVisible({ timeout: 10_000 })
	await expect.poll(() => result.textContent(), { timeout: 10_000 }).not.toBe(before)
	const text = (await result.textContent()) ?? ''
	const match = text.match(/replayed\s+(\d+)\s+of\s+(\d+)/)
	const replayed = Number(match?.[1] ?? Number.NaN)
	const total = Number(match?.[2] ?? Number.NaN)
	expect(replayed).toBeGreaterThanOrEqual(0)
	expect(replayed).toBeLessThanOrEqual(total)
	expect(total).toBeGreaterThan(0)
	return { replayed, total }
}

export async function replayOne(page, shortId) {
	return replay(page, dlqRow(page, shortId).getByTestId('ow-replay'))
}

export async function replayAll(page) {
	return replay(page, page.getByTestId('ow-replay-all'))
}
