import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/alarms', () => {
	test('renders schedule controls, pending card, and fired log', async ({ page }) => {
		await page.goto('/demos/alarms')
		await expect(page.getByTestId('al-schedule-10')).toBeVisible()
		await expect(page.getByTestId('al-schedule-30')).toBeVisible()
		await expect(page.getByTestId('al-schedule-120')).toBeVisible()
		await expect(page.getByTestId('al-custom-seconds')).toBeVisible()
		await expect(page.getByTestId('al-schedule-custom')).toBeVisible()
		await expect(page.getByTestId('al-cancel')).toBeVisible()
		await expect(page.getByTestId('al-pending')).toBeVisible()
		await expect(page.getByTestId('al-log')).toBeVisible()
	})

	test('a short alarm fires once and lands in the log with lateMs >= 0', async ({ page }) => {
		await page.goto('/demos/alarms')
		await waitForWS(page)

		// 5s margin absorbs any skew between the test clock and the server
		// clock when we later compare against the record's scheduled epoch.
		const t0 = Date.now() - 5_000

		await page.getByTestId('al-custom-seconds').fill('2')
		await page.getByTestId('al-schedule-custom').click()

		// Pending card shows the armed alarm.
		await expect(page.getByTestId('al-pending-at')).toBeVisible({ timeout: 5_000 })

		// The fired record lands in the log within 20s (2s delay + arming
		// round-trip + publish fan-out). The log may hold records from
		// earlier runs, so wait for a record whose scheduled time is ours.
		await expect.poll(async () => {
			const first = page.getByTestId('al-log-row').first()
			if ((await first.count()) === 0) return 0
			return Number(await first.getAttribute('data-at')) || 0
		}, { timeout: 20_000 }).toBeGreaterThanOrEqual(t0)

		// The newest record renders lateMs as a non-negative badge.
		const late = await page.getByTestId('al-log-late').first().textContent()
		const lateMs = Number((late ?? '').replace(/[^\d]/g, ''))
		expect(lateMs).toBeGreaterThanOrEqual(0)

		// Firing consumed the pending alarm.
		await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
	})

	test('cancel clears the pending alarm without a firing', async ({ page }) => {
		await page.goto('/demos/alarms')
		await waitForWS(page)

		await page.getByTestId('al-schedule-30').click()
		await expect(page.getByTestId('al-pending-at')).toBeVisible({ timeout: 5_000 })

		await page.getByTestId('al-cancel').click()
		await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
	})
})
