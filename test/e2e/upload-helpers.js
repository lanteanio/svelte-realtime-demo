import { expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

export async function openUpload(page, url = '/demos/upload') {
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('upload-form')).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('push-ready')).toBeAttached({ timeout: 10_000 })
}

export async function clearUploads(page) {
	// The clear control is honestly disabled when there is nothing to clear.
	if (await page.getByTestId('files-list-empty').isVisible().catch(() => false)) return
	await confirmAndClick(page.getByTestId('clear-button'))
	await expect(page.getByTestId('files-list-empty')).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('stat-files')).toHaveText('0')
	await expect(page.getByTestId('stat-chunks')).toHaveText('0')
	await expect(page.getByTestId('stat-bytes')).toHaveText('0 B')
}

export async function uploadSyntheticFile(page, { seed, sizeBytes, filename }) {
	await page.evaluate(async ({ seed, sizeBytes, filename }) => {
		const pattern = new TextEncoder().encode(seed)
		const bytes = new Uint8Array(sizeBytes)
		for (let i = 0; i < sizeBytes; i++) bytes[i] = pattern[i % pattern.length] ^ (i & 0xff)
		const transfer = new DataTransfer()
		transfer.items.add(new File([bytes], filename, { type: 'application/octet-stream' }))
		const input = document.querySelector('[data-testid="file-input"]')
		input.files = transfer.files
		input.dispatchEvent(new Event('change', { bubbles: true }))
	}, { seed, sizeBytes, filename })
}

export async function selectOversizeFile(page, filename) {
	await page.evaluate((name) => {
		const file = new File([new Uint8Array(1)], name, { type: 'application/octet-stream' })
		Object.defineProperty(file, 'size', { value: 50 * 1024 * 1024 + 1 })
		const transfer = new DataTransfer()
		transfer.items.add(file)
		const input = document.querySelector('[data-testid="file-input"]')
		input.files = transfer.files
		input.dispatchEvent(new Event('change', { bubbles: true }))
	}, filename)
}

export function fileRow(page, filename) {
	return page.getByTestId('file-row').filter({ has: page.getByTestId('file-row-name').filter({ hasText: filename }) })
}

export async function waitForUpload(page, filename) {
	await expect(page.getByTestId('upload-result')).toBeVisible({ timeout: 20_000 })
	await expect(page.getByTestId('result-filename')).toHaveText(filename)
	await expect(page.getByTestId('file-input')).toBeEnabled({ timeout: 10_000 })
	const totalChunks = Number(await page.getByTestId('result-total-chunks').textContent())
	const dedupedChunks = Number(await page.getByTestId('result-deduped').textContent())
	return { totalChunks, dedupedChunks }
}

export async function waitForFile(page, filename) {
	const row = fileRow(page, filename)
	await expect(row).toHaveCount(1, { timeout: 15_000 })
	return row
}
