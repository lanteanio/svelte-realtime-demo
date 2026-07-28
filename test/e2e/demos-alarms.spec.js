import { test, expect } from '@playwright/test'
import {
	cancelPending,
	countdownSeconds,
	expectCountdownBetween,
	expectRecentAlarmCount,
	openAlarms,
	recentAlarms,
	scheduleCustom
} from './alarms-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/alarms', () => {
	test('renders every schedule control, the pending card, fired log, identity, and source link', async ({ page }) => {
		await openAlarms(page)
		await expect(page.getByRole('heading', { name: 'Durable alarms: one-shot timers that survive restarts' })).toBeVisible()
		for (const id of ['al-schedule-10', 'al-schedule-30', 'al-schedule-120', 'al-schedule-custom', 'al-cancel']) {
			await expect(page.getByTestId(id)).toBeVisible()
			await expect(page.getByTestId(id)).toBeEnabled()
		}
		const custom = page.getByTestId('al-custom-seconds')
		await expect(custom).toHaveValue('10')
		await expect(custom).toHaveAttribute('min', '2')
		await expect(custom).toHaveAttribute('max', '600')
		await expect(custom).toHaveAttribute('step', '1')
		await expect(page.getByTestId('al-pending')).toBeVisible()
		await expect(page.getByTestId('al-log')).toBeVisible()
		await expect(page.getByText('Scheduling as')).toBeVisible()
		await expect(page.getByRole('link', { name: 'alarms.js' })).toHaveAttribute('href', /src\/live\/demos\/alarms\.js$/)
	})

	test('all three presets replace the shared pending alarm and update its honest countdown', async ({ page }) => {
		await openAlarms(page)
		try {
			await cancelPending(page)
			await page.getByTestId('al-schedule-120').click()
			await expectCountdownBetween(page, 110, 120)

			await page.getByTestId('al-schedule-30').click()
			await expectCountdownBetween(page, 20, 30)

			await page.getByTestId('al-schedule-10').click()
			await expectCountdownBetween(page, 5, 10)
		} finally {
			await cancelPending(page)
		}
	})

	test('custom bounds block invalid human input and cancel prevents a valid alarm from firing', async ({ page }) => {
		await openAlarms(page)
		await cancelPending(page)
		const input = page.getByTestId('al-custom-seconds')
		for (const invalid of ['1', '601']) {
			await input.fill(invalid)
			expect(await input.evaluate((element) => element.checkValidity())).toBe(false)
			await page.getByTestId('al-schedule-custom').click()
			// `al-pending-empty` is ALREADY visible from cancelPending, so
			// asserting it here would pass instantly even if the click had armed
			// a 601s alarm one RPC round trip later. Instead drive a known-valid
			// schedule through the very same control and wait for it to arm:
			// that gives a rejected value more than a round trip to appear, and
			// the countdown proves WHICH value armed. A leaked 1s or 601s alarm
			// lands outside the 20..30 bracket and fails.
			await expect(page.getByTestId('al-pending-empty')).toBeVisible()
			await scheduleCustom(page, 30)
			await expectCountdownBetween(page, 20, 30)
			await expect(page.getByTestId('al-error')).toHaveCount(0)
			await cancelPending(page)
		}

		const since = Date.now() - 1_000
		await scheduleCustom(page, 2)
		await expectCountdownBetween(page, 1, 2)
		await cancelPending(page)
		await page.waitForTimeout(3_000)
		expect(await recentAlarms(page, since)).toHaveLength(0)
	})

	test('a short alarm fires exactly once, records timing metadata, and consumes the pending alarm', async ({ page }) => {
		await openAlarms(page)
		await cancelPending(page)
		const since = Date.now() - 1_000
		await scheduleCustom(page, 2)
		await expectCountdownBetween(page, 1, 2)
		await expectRecentAlarmCount(page, since, 1)

		const [record] = await recentAlarms(page, since)
		expect(record.text).toContain('scheduled')
		expect(record.text).toContain('fired')
		expect(record.lateMs).toBeGreaterThanOrEqual(0)
		expect(record.text).toMatch(/precise timer|recovered/)
		await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })

		await page.waitForTimeout(2_500)
		expect(await recentAlarms(page, since)).toHaveLength(1)
	})

	test('schedule in one tab and cancel in another propagate both ways', async ({ page, browser }) => {
		await openAlarms(page)
		await cancelPending(page)
		const otherContext = await browser.newContext()
		const other = await otherContext.newPage()
		try {
			await openAlarms(other)
			await page.getByTestId('al-schedule-30').click()
			await expectCountdownBetween(other, 20, 30)
			await other.getByTestId('al-cancel').click()
			await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
			await expect(other.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
		} finally {
			await otherContext.close()
			await cancelPending(page)
		}
	})

	test('the durable alarm fires while every subscriber tab is closed', async ({ page, context }) => {
		await openAlarms(page)
		await cancelPending(page)
		const since = Date.now() - 1_000
		await scheduleCustom(page, 2)
		await expectCountdownBetween(page, 1, 2)
		await page.close()
		await new Promise((resolve) => setTimeout(resolve, 3_500))

		const reopened = await context.newPage()
		await openAlarms(reopened)
		await expectRecentAlarmCount(reopened, since, 1, 8_000)
		await expect(reopened.getByTestId('al-pending-empty')).toBeVisible()
	})
})
