import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Entries are capped at 50 server-side and the purge cron wipes the
// guestbook on its schedule, so this spec needs no cleanup - unique
// entry text per run keeps assertions unambiguous in the meantime.

test.describe('/demos/offline', () => {
	test('online post lands in the list and pending count settles at 0', async ({ page }) => {
		await page.goto('/demos/offline')
		await waitForWS(page)

		// Connected and idle: nothing queued.
		await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 10_000 })

		const text = `online-${Date.now()}`
		await page.getByTestId('off-input').fill(text)
		await page.getByTestId('off-post-button').click()

		await expect(page.getByTestId('off-entries')).toContainText(text, { timeout: 10_000 })
		// An online call never touches the queue.
		await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 10_000 })
	})

	test('offline post queues, then replays exactly once on reconnect', async ({ page, context, browserName }) => {
		test.skip(browserName !== 'chromium', 'context.setOffline network emulation is exercised on chromium only')
		test.setTimeout(120_000)

		await page.goto('/demos/offline')
		await waitForWS(page)
		await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 10_000 })

		await context.setOffline(true)
		// Wait for the client to notice the drop: the navbar status icon
		// leaves its success state when the socket closes, which is the
		// same transition that arms the offline queue.
		await expect(page.locator('.text-success')).toHaveCount(0, { timeout: 30_000 })

		const text = `offline-${Date.now()}`
		await page.getByTestId('off-input').fill(text)
		await page.getByTestId('off-post-button').click()

		// The call queued instead of erroring.
		await expect.poll(
			async () => Number(await page.getByTestId('off-pending-count').textContent()),
			{ timeout: 15_000 }
		).toBeGreaterThanOrEqual(1)
		await expect(page.getByTestId('off-error')).toHaveCount(0)

		await context.setOffline(false)
		// Reconnect drains the queue: pending returns to 0 and the entry
		// lands exactly once (the replay carries an idempotency key that
		// the server-side live.idempotent wrapper dedups on).
		await expect(page.getByTestId('off-pending-count')).toHaveText('0', { timeout: 60_000 })
		await expect(page.getByTestId('off-entries').locator('li', { hasText: text })).toHaveCount(1, { timeout: 30_000 })
	})
})
