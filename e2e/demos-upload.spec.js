import { test, expect } from '@playwright/test'

const RUN = `e2e-upload-${Date.now()}`

async function gotoFreshUpload(page) {
	await page.goto('/demos/upload')
	await expect(page.getByTestId('upload-form')).toBeVisible({ timeout: 10_000 })
	await page.getByTestId('clear-button').click()
	await expect(page.getByTestId('files-list-empty')).toBeVisible({ timeout: 5_000 })
}

/**
 * Build a deterministic file payload inside the browser. Every byte
 * pattern is reproducible from the seed string so the same seed produces
 * the same chunk hashes.
 */
async function uploadSyntheticFile(page, { seed, sizeBytes, filename }) {
	const buf = await page.evaluate(async ({ seed, sizeBytes }) => {
		const enc = new TextEncoder().encode(seed)
		const out = new Uint8Array(sizeBytes)
		for (let i = 0; i < sizeBytes; i++) {
			out[i] = enc[i % enc.length] ^ (i & 0xff)
		}
		// Stash a File on window for the input to consume.
		const file = new File([out], 'placeholder', { type: 'application/octet-stream' })
		window.__syntheticFile = file
		return sizeBytes
	}, { seed, sizeBytes })

	// DataTransfer dance to feed the File into the input.
	await page.evaluate(async ({ filename }) => {
		const file = window.__syntheticFile
		const dt = new DataTransfer()
		dt.items.add(new File([await file.arrayBuffer()], filename, { type: 'application/octet-stream' }))
		const input = document.querySelector('[data-testid="file-input"]')
		input.files = dt.files
		input.dispatchEvent(new Event('change', { bubbles: true }))
	}, { filename })

	return buf
}

test.describe('/demos/upload', () => {
	test('renders form, stats strip, and files list', async ({ page }) => {
		await gotoFreshUpload(page)
		await expect(page.getByTestId('upload-stats-strip')).toBeVisible()
		await expect(page.getByTestId('upload-form')).toBeVisible()
		await expect(page.getByTestId('files-list')).toBeVisible()
		await expect(page.getByTestId('file-input')).toBeVisible()
		await expect(page.locator('h1')).toContainText('Upload')
	})

	test('upload a small synthetic file, see it in the list with chunk count + size', async ({ page }) => {
		page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()))
		page.on('pageerror', (err) => console.log('[browser pageerror]', err.message))
		await gotoFreshUpload(page)

		// live.upload auto-sizes chunks based on platform.maxPayloadLength,
		// so we don't pin a specific chunk count - just assert the file
		// uploaded and registered at least one chunk.
		const sizeBytes = 200 * 1024
		await uploadSyntheticFile(page, { seed: `${RUN}-A`, sizeBytes, filename: `${RUN}-A.bin` })

		const row = page.getByTestId('file-row').first()
		await expect(row).toBeVisible({ timeout: 15_000 })
		await expect(row.getByTestId('file-row-name')).toHaveText(`${RUN}-A.bin`)
		await expect(row.getByTestId('file-row-chunks')).toHaveText(/^\d+$/)

		const upResult = page.getByTestId('upload-result')
		await expect(upResult).toBeVisible({ timeout: 8_000 })
		await expect(upResult.getByTestId('result-total-chunks')).toHaveText(/^\d+$/)
		// Synthetic-bytes seeds are nearly-but-not-quite collision-free
		// against the redis cache of prior test-run chunks; assert dedup
		// is significantly less than total to keep the test stable. The
		// dedup demo's strict "every chunk deduped on re-upload" lives in
		// the next test.
		const total = Number((await upResult.getByTestId('result-total-chunks').textContent())?.trim() ?? '0')
		const deduped = Number((await upResult.getByTestId('result-deduped').textContent())?.trim() ?? '0')
		expect(total).toBeGreaterThan(0)
		expect(deduped).toBeLessThan(Math.max(2, Math.floor(total / 2)))
	})

	test('re-upload of the same file dedupes every chunk', async ({ page }) => {
		await gotoFreshUpload(page)

		const sizeBytes = 200 * 1024
		const seed = `${RUN}-DEDUP`

		await uploadSyntheticFile(page, { seed, sizeBytes, filename: `${seed}.bin` })
		await expect(page.getByTestId('upload-result')).toBeVisible({ timeout: 15_000 })
		// Wait for upload to settle (the input is disabled while uploading).
		await expect(page.getByTestId('file-input')).toBeEnabled({ timeout: 8_000 })

		// Capture how many chunks the first upload produced; the second
		// upload should match it AND have every chunk deduped.
		const firstChunks = (await page.getByTestId('result-total-chunks').first().textContent())?.trim() ?? ''

		// Clear the file list so the second run's row is unambiguous; the
		// chunk cache + redis idempotency keys persist across the clear.
		await page.getByTestId('clear-button').click()
		await expect(page.getByTestId('files-list-empty')).toBeVisible({ timeout: 5_000 })

		await uploadSyntheticFile(page, { seed, sizeBytes, filename: `${seed}-2.bin` })

		const row = page.getByTestId('file-row').first()
		await expect(row).toBeVisible({ timeout: 15_000 })
		// Every chunk on the re-upload is a cache hit. Both totals match
		// the first upload's chunk count even if live.upload renegotiated
		// chunk size between the two (auto-discovery may bump after the
		// first round-trip).
		await expect(row.getByTestId('file-row-deduped')).toHaveText(firstChunks, { timeout: 8_000 })
		await expect(row.getByTestId('file-row-chunks')).toHaveText(firstChunks)

		const upResult = page.getByTestId('upload-result')
		await expect(upResult.getByTestId('result-deduped')).toHaveText(firstChunks)
	})

	test('cross-device push: upload from tab A, tab B sees the incoming banner', async ({ browser }) => {
		// Two contexts share one identity cookie so the live.push targets
		// both tabs as "the same user".
		const ctxA = await browser.newContext()
		const a = await ctxA.newPage()
		await a.goto('/demos/upload')
		await expect(a.getByTestId('upload-form')).toBeVisible({ timeout: 10_000 })
		const cookies = await ctxA.cookies()
		const identityCookie = cookies.find((c) => c.name === 'identity')
		expect(identityCookie, 'identity cookie set on first page load').toBeTruthy()

		const ctxB = await browser.newContext()
		await ctxB.addCookies([{ ...identityCookie }])
		const b = await ctxB.newPage()
		await b.goto('/demos/upload')
		await expect(b.getByTestId('upload-form')).toBeVisible({ timeout: 10_000 })

		try {
			await a.getByTestId('clear-button').click()
			await expect(a.getByTestId('files-list-empty')).toBeVisible({ timeout: 5_000 })

			const sizeBytes = 128 * 1024
			const filename = `${RUN}-XDEV.bin`
			await uploadSyntheticFile(a, { seed: `${RUN}-XDEV`, sizeBytes, filename })

			// A's row lands.
			await expect(a.getByTestId('file-row').first()).toBeVisible({ timeout: 15_000 })

			// B sees the cross-device push banner within a few seconds.
			await expect(b.getByTestId('incoming-banner')).toBeVisible({ timeout: 8_000 })
			await expect(b.getByTestId('incoming-filename').first()).toHaveText(filename)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
