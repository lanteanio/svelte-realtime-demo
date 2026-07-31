import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, sharedIdentityState } from './helpers.js'
import {
	clearUploads,
	fileRow,
	openUpload,
	selectOversizeFile,
	uploadSyntheticFile,
	waitForFile,
	waitForUpload
} from './upload-helpers.js'

const RUN = `e2e-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`

test.describe.configure({ mode: 'serial' })

test.describe('/demos/upload', () => {
	test('renders every idle control, stats state, limits disclosure, and empty clear behavior', async ({ page }) => {
		await openUpload(page)
		await clearUploads(page)
		await expect(page.getByRole('heading', { name: 'Upload: streaming uploads with content-addressed dedup' })).toBeVisible()
		await expect(page.getByTestId('upload-stats-strip')).toBeVisible()
		await expect(page.getByTestId('file-input')).toHaveAttribute('type', 'file')
		await expect(page.getByTestId('file-input')).toBeEnabled()
		await expect(page.getByTestId('clear-button')).toBeDisabled()
		await expect(page.getByTestId('cancel-button')).toHaveCount(0)
		await expect(page.getByTestId('upload-progress')).toHaveCount(0)
		await expect(page.getByTestId('upload-error')).toHaveCount(0)
		await expect(page.getByTestId('upload-result')).toHaveCount(0)
		await expect(page.getByTestId('stat-idempotency')).toHaveText(/redis|memory only/)
		await expect(page.getByText('0x00 marker + uint16 BE header length', { exact: false })).toBeVisible()
		await expect(page.getByText('live.notify', { exact: false }).first()).toBeVisible()
	})

	test('uploads a multi-chunk file, exposes progress/result metadata, updates stats, and clears it', async ({ page }) => {
		await openUpload(page)
		await clearUploads(page)
		const filename = `${RUN}-fresh.bin`
		await uploadSyntheticFile(page, { seed: `${RUN}-fresh`, sizeBytes: 700 * 1024, filename })
		const result = await waitForUpload(page, filename)
		expect(result.totalChunks).toBeGreaterThan(1)
		expect(result.dedupedChunks).toBeLessThan(result.totalChunks)
		await expect(page.getByTestId('upload-progress')).toBeVisible()
		const totalText = await page.getByTestId('progress-total').textContent()
		await expect(page.getByTestId('progress-sent')).toHaveText(totalText ?? '')
		await expect(page.getByTestId('progress-chunks')).toHaveText(String(result.totalChunks))
		const row = await waitForFile(page, filename)
		await expect(row.getByTestId('file-row-chunks')).toHaveText(String(result.totalChunks))
		await expect(page.getByTestId('stat-files')).toHaveText('1')
		await expect(page.getByTestId('stat-bytes')).toHaveText('700.0 KB')
		await clearUploads(page)
		await expect(fileRow(page, filename)).toHaveCount(0)
	})

	test('re-uploading identical bytes dedupes every chunk after Clear all', async ({ page }) => {
		await openUpload(page)
		await clearUploads(page)
		const seed = `${RUN}-dedup`
		await uploadSyntheticFile(page, { seed, sizeBytes: 200 * 1024, filename: `${seed}-first.bin` })
		const first = await waitForUpload(page, `${seed}-first.bin`)
		expect(first.totalChunks).toBe(1)
		await clearUploads(page)

		await uploadSyntheticFile(page, { seed, sizeBytes: 200 * 1024, filename: `${seed}-second.bin` })
		const second = await waitForUpload(page, `${seed}-second.bin`)
		expect(second).toEqual({ totalChunks: first.totalChunks, dedupedChunks: first.totalChunks })
		const row = await waitForFile(page, `${seed}-second.bin`)
		await expect(row.getByTestId('file-row-deduped')).toHaveText(String(first.totalChunks))
		await clearUploads(page)
	})

	test('rejects client-oversize and server-empty selections, then recovers for another choice', async ({ page }) => {
		await openUpload(page)
		await clearUploads(page)
		await selectOversizeFile(page, `${RUN}-oversize.bin`)
		await expect(page.getByTestId('upload-error')).toContainText('file too large (max 50.00 MB)')
		await expect(page.getByTestId('upload-progress')).toHaveCount(0)

		await page.getByTestId('file-input').setInputFiles({
			name: `${RUN}-empty.bin`,
			mimeType: 'application/octet-stream',
			buffer: Buffer.alloc(0)
		})
		await expect(page.getByTestId('upload-error')).toContainText('empty upload', { timeout: 10_000 })
		await expect(page.getByTestId('file-input')).toBeEnabled()
		await expect(page.getByTestId('clear-button')).toBeDisabled()
	})

	test('Cancel aborts an active upload and does not finalize a file row', async ({ page }) => {
		test.setTimeout(45_000)
		await openUpload(page)
		await clearUploads(page)
		const filename = `${RUN}-cancel.bin`
		await uploadSyntheticFile(page, { seed: `${RUN}-cancel`, sizeBytes: 8 * 1024 * 1024, filename })
		await expect(page.getByTestId('cancel-button')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('file-input')).toBeDisabled()
		await expect(page.getByTestId('clear-button')).toBeDisabled()
		await page.getByTestId('cancel-button').click()
		await expect(page.getByTestId('upload-error')).toContainText(/cancel/i, { timeout: 15_000 })
		await expect(page.getByTestId('file-input')).toBeEnabled()
		await expect(fileRow(page, filename)).toHaveCount(0)
		await clearUploads(page)
	})

	test('most-recent same-identity tab receives the completed-upload push and shared file row', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const a = await ctxA.newPage()
		await openUpload(a)
		const state = await sharedIdentityState(ctxA)
		const ctxB = await browser.newContext({ storageState: state })
		const b = await ctxB.newPage()
		await openUpload(b)
		try {
			await clearUploads(a)
			const filename = `${RUN}-push.bin`
			await uploadSyntheticFile(a, { seed: `${RUN}-push`, sizeBytes: 300 * 1024, filename })
			await waitForUpload(a, filename)
			await waitForFile(b, filename)
			await expect(b.getByTestId('incoming-banner')).toBeVisible({ timeout: 10_000 })
			await expect(b.getByTestId('incoming-filename').first()).toHaveText(filename)
			await clearUploads(a)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		test.setTimeout(45_000)
		const { context, page } = await openTouchPage(browser)
		try {
			await openUpload(page)
			await expectTouchTarget(page.getByTestId('file-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('clear-button'))
			// The smallest control only exists mid-flight: start a real upload
			// large enough to keep it on screen, then measure it live.
			await clearUploads(page)
			const filename = `${RUN}-touch-cancel.bin`
			await uploadSyntheticFile(page, { seed: `${RUN}-touch-cancel`, sizeBytes: 8 * 1024 * 1024, filename })
			await expect(page.getByTestId('cancel-button')).toBeVisible({ timeout: 5_000 })
			await expectTouchTarget(page.getByTestId('cancel-button'))
			await page.getByTestId('cancel-button').click()
			await expect(page.getByTestId('file-input')).toBeEnabled({ timeout: 15_000 })
			await clearUploads(page)
		} finally {
			await context.close()
		}
	})
})
