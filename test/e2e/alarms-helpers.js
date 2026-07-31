import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openAlarms(page, target = '/demos/alarms') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByTestId('al-schedule-section')).toBeVisible()
}

export async function cancelPending(page) {
	// Cancel is honestly disabled when nothing is pending; only click when
	// there is something to cancel.
	if (await page.getByTestId('al-cancel').isEnabled()) {
		await page.getByTestId('al-cancel').click()
	}
	await expect(page.getByTestId('al-pending-empty')).toBeVisible({ timeout: 5_000 })
}

export async function scheduleCustom(page, seconds) {
	await page.getByTestId('al-custom-seconds').fill(String(seconds))
	await page.getByTestId('al-schedule-custom').click()
}

export async function countdownSeconds(page) {
	const text = (await page.getByTestId('al-pending-countdown').textContent()) ?? ''
	const match = text.trim().match(/^(?:(\d+)m\s+)?(\d+)s$/)
	return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : Number.NaN
}

export async function expectCountdownBetween(page, min, max) {
	await expect(page.getByTestId('al-pending-at')).toBeVisible({ timeout: 5_000 })
	await expect.poll(() => countdownSeconds(page), { timeout: 5_000 }).toBeLessThanOrEqual(max)
	expect(await countdownSeconds(page)).toBeGreaterThanOrEqual(min)
}

export async function recentAlarms(page, since) {
	return page.getByTestId('al-log-row').evaluateAll((rows, threshold) => rows
		.map((row) => ({
			at: Number(row.getAttribute('data-at')),
			text: row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
			lateMs: Number(row.querySelector('[data-testid="al-log-late"]')?.textContent?.match(/\d+/)?.[0] ?? Number.NaN),
			recovered: Boolean(row.querySelector('[data-testid="al-log-recovered"]'))
		}))
		.filter((row) => Number.isFinite(row.at) && row.at >= threshold), since)
}

export async function expectRecentAlarmCount(page, since, count, timeout = 15_000) {
	await expect.poll(async () => (await recentAlarms(page, since)).length, { timeout }).toBe(count)
}
