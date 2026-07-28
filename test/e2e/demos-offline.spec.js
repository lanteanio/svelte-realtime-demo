import { test, expect } from '@playwright/test'
import {
	checkpointSeq,
	entryRows,
	openOffline,
	pendingCount,
	postEntry,
	reconnect,
	simulateOffline,
	waitExactlyOnce
} from './offline-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/offline', () => {
	test('renders every queue state, composer control, exact-once disclosure, and source link', async ({ page }) => {
		await openOffline(page)
		await expect(page.getByRole('heading', { name: 'Offline queue: post now, sync later' })).toBeVisible()
		await expect(page.getByTestId('off-status-strip')).toContainText('0 queued edits')
		await expect(page.getByTestId('off-checkpoint-seq')).toHaveText(/^\d+$/)
		await expect(page.getByTestId('off-uploading')).toHaveCount(0)
		await expect(page.getByTestId('off-gap-badge')).toHaveCount(0)
		await expect(page.getByTestId('off-sim-card')).toContainText('Connected. Go offline')
		await expect(page.getByTestId('off-sim-toggle')).toHaveText('Go offline')
		const input = page.getByTestId('off-input')
		await expect(input).toHaveAttribute('maxlength', '200')
		await expect(input).toHaveAttribute('placeholder', 'Sign the guestbook... (works offline)')
		await expect(page.getByTestId('off-post-button')).toBeDisabled()
		await input.fill('   ')
		await expect(page.getByTestId('off-post-button')).toBeDisabled()
		await input.fill('ready')
		await expect(page.getByTestId('off-post-button')).toBeEnabled()
		await input.fill('')
		await expect(page.getByTestId('off-error')).toHaveCount(0)
		await expect(page.getByText('persists the queue to IndexedDB', { exact: false })).toBeVisible()
		await expect(page.getByRole('link', { name: 'src/live/demos/offline.js' })).toHaveAttribute('href', /src\/live\/demos\/offline\.js$/)
	})

	test('online button and Enter posts propagate exactly once to a same-identity second tab', async ({ page, context }) => {
		await openOffline(page)
		const other = await context.newPage()
		await openOffline(other)
		try {
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const byButton = `online-button-${stamp}`
			const byEnter = `online-enter-${stamp}`
			await postEntry(page, byButton)
			await postEntry(page, byEnter, true)
			for (const text of [byButton, byEnter]) {
				await Promise.all([waitExactlyOnce(page, text), waitExactlyOnce(other, text)])
			}
			expect(await pendingCount(page)).toBe(0)
			await expect(page.getByTestId('off-error')).toHaveCount(0)
		} finally {
			await other.close()
		}
	})

	test('in-page offline toggle queues three posts, advances the checkpoint, and replays each once', async ({ page }) => {
		test.setTimeout(120_000)
		await openOffline(page)
		const beforeCheckpoint = await checkpointSeq(page)
		await simulateOffline(page)
		const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
		const texts = [0, 1, 2].map((index) => `sim-${index}-${stamp}`)
		for (const text of texts) await postEntry(page, text)
		await expect.poll(() => pendingCount(page), { timeout: 15_000 }).toBe(3)
		for (const text of texts) await expect(entryRows(page, text)).toHaveCount(0)
		await expect(page.getByTestId('off-error')).toHaveCount(0)

		await reconnect(page)
		for (const text of texts) await waitExactlyOnce(page, text)
		await expect.poll(() => checkpointSeq(page), { timeout: 10_000 }).toBeGreaterThan(beforeCheckpoint)
		await expect(page.getByTestId('off-gap-badge')).toHaveCount(0)
	})

	test('a queued mutation persists through a full page reload and drains exactly once', async ({ page }) => {
		test.setTimeout(120_000)
		await openOffline(page)
		await simulateOffline(page)
		const text = `reload-${Date.now()}-${Math.random().toString(16).slice(2)}`
		await postEntry(page, text)
		await expect.poll(() => pendingCount(page), { timeout: 15_000 }).toBe(1)
		await page.reload()
		await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 60_000 })
		await waitExactlyOnce(page, text)
		await page.waitForTimeout(1_000)
		await expect(entryRows(page, text)).toHaveCount(1)
		await expect(page.getByTestId('off-gap-badge')).toHaveCount(0)
	})

	test('browser network-offline post replays exactly once on reconnect (RT-350)', async ({ page, context, browserName }) => {
		test.skip(browserName !== 'chromium', 'context.setOffline network emulation is exercised on chromium only')
		test.setTimeout(120_000)
		await openOffline(page)
		await context.setOffline(true)
		try {
			await expect(page.locator('.text-success')).toHaveCount(0, { timeout: 30_000 })
			const text = `network-offline-${Date.now()}-${Math.random().toString(16).slice(2)}`
			await postEntry(page, text)
			await expect.poll(() => pendingCount(page), { timeout: 15_000 }).toBe(1)
			await expect(page.getByTestId('off-error')).toHaveCount(0)
			await context.setOffline(false)
			await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 60_000 })
			await waitExactlyOnce(page, text)
			await page.waitForTimeout(1_000)
			await expect(entryRows(page, text)).toHaveCount(1)
		} finally {
			await context.setOffline(false)
		}
	})
})
