import { test, expect } from '@playwright/test'

test.describe('/demos/from-seq', () => {
	test('initial render: events appear within 5s; tier counts populate (rehydrate or live)', async ({ page }) => {
		await page.goto('/demos/from-seq')
		// The cron fires once per second; within 5s we expect at least
		// a couple of events. The exact count varies by timing.
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
		// At least one tier counter is non-zero.
		const liveText = await page.getByTestId('tier-live').textContent()
		const rehText = await page.getByTestId('tier-rehydrate').textContent()
		const total = parseInt((liveText?.match(/(\d+)/) ?? ['0', '0'])[1], 10) +
			parseInt((rehText?.match(/(\d+)/) ?? ['0', '0'])[1], 10)
		expect(total).toBeGreaterThan(0)
	})

	test('pause + resume: replay buffer fills the gap (no cold rehydrate)', async ({ page }) => {
		// Guards against the regression where unsubscribe wipes `_lastSeq`
		// (so resume sends no seq, the server treats it as a fresh subscribe,
		// the loader runs, and the recent window arrives tagged `rehydrate`
		// instead of the replay buffer delivering the gap tagged `live`).
		// The fix is realtime's resume-grace window (configured globally in
		// the root layout); this test asserts the gap-fill path actually
		// fires, not just that "some row exists after resume".
		await page.goto('/demos/from-seq')

		const readCount = async (/** @type {string} */ testid) => {
			const txt = (await page.getByTestId(testid).textContent()) ?? ''
			const m = txt.match(/(\d+)/)
			return m ? parseInt(m[1], 10) : 0
		}

		// Wait for the initial loader to land and at least one cron tick to
		// hit the live store - we need a non-null _lastSeq before pausing.
		await expect.poll(() => readCount('tier-rehydrate'), { timeout: 8_000 }).toBeGreaterThan(0)
		await expect.poll(() => readCount('tier-live'), { timeout: 8_000 }).toBeGreaterThan(0)

		const rehydrateBefore = await readCount('tier-rehydrate')

		// Pause and let the cron publish a few ticks into the replay buffer.
		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('status')).toContainText('paused', { timeout: 3_000 })
		await page.waitForTimeout(4_000)

		// Resume - the SDK should ride the retained _lastSeq into the
		// subscribe envelope and the server should gap-fill from the
		// replay buffer.
		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('status')).toContainText('subscribed', { timeout: 3_000 })

		// The page detects gap-fill events (tier=live, seq>pausedAtSeq,
		// ts<resumedAt) and shows the banner for 5s. Its presence is the
		// positive signal that the replay-buffer tier delivered.
		await expect(page.getByTestId('replay-banner')).toBeVisible({ timeout: 3_000 })

		// Cold rehydrate would grow the rehydrate counter by the loader's
		// recent-window size (~20). The gap-fill path leaves it untouched.
		const rehydrateAfter = await readCount('tier-rehydrate')
		expect(rehydrateAfter).toBe(rehydrateBefore)

		// At least two events arrived via the replay tier - more than the
		// race-condition single event seen even under the cold-rehydrate
		// bug, so this distinguishes "gap-fill worked" from "one stray
		// event landed in the same flush as the loader response".
		await expect.poll(() => readCount('tier-replay'), { timeout: 3_000 }).toBeGreaterThan(1)
	})

	test('event rows have a tier badge populated to one of live / rehydrate / fromSeq', async ({ page }) => {
		await page.goto('/demos/from-seq')
		await expect.poll(
			async () => (await page.getByTestId('event-row').count()),
			{ timeout: 8_000 }
		).toBeGreaterThanOrEqual(1)
		const firstRow = page.getByTestId('event-row').first()
		const tierBadge = firstRow.locator('[data-testid^="event-tier-"]')
		const tierText = await tierBadge.textContent()
		expect(['live', 'rehydrate', 'fromSeq']).toContain((tierText ?? '').trim())
	})
})
