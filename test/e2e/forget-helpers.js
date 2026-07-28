import { expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

export const EXPECTED_SURFACES = [
	'appDemoLog',
	'push',
	'presence',
	'rateLimit',
	'idempotency',
	'smooth',
	'webhookDeadLetter',
	'aggregateCohorts',
	'durable'
]

export async function openForget(page, target = '/demos/forget') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByTestId('fg-traces-section')).toBeVisible()
}

async function clickThroughBusy(button, timeout = 10_000, needsConfirmation = false) {
	const marker = `${Date.now()}-${Math.random()}`
	await button.evaluate((element, token) => {
		const waiting = `${token}:waiting`
		const done = `${token}:done`
		element.setAttribute('data-e2e-busy-cycle', waiting)
		let sawBusy = element.disabled
		const observer = new MutationObserver(() => {
			if (element.disabled) sawBusy = true
			else if (sawBusy) {
				element.setAttribute('data-e2e-busy-cycle', done)
				observer.disconnect()
			}
		})
		observer.observe(element, { attributes: true, attributeFilter: ['disabled'] })
	}, marker)
	if (needsConfirmation) await confirmAndClick(button)
	else await button.click()
	await expect(button).toHaveAttribute('data-e2e-busy-cycle', `${marker}:done`, { timeout })
	await button.evaluate((element) => element.removeAttribute('data-e2e-busy-cycle'))
}

export async function leaveTraces(page) {
	const container = page.getByTestId('fg-traces-result')
	await clickThroughBusy(page.getByTestId('fg-leave-traces'))
	await expect(container).toBeVisible({ timeout: 5_000 })
	const error = page.getByTestId('fg-error')
	if ((await error.count()) > 0) throw new Error(`leave traces failed: ${await error.textContent()}`)
	return traceResult(page)
}

export async function traceResult(page) {
	const text = (await page.getByTestId('fg-traces-applog').textContent()) ?? ''
	const match = text.match(/\+(\d+) entries \((\d+) total/)
	return {
		added: Number(match?.[1] ?? Number.NaN),
		total: Number(match?.[2] ?? Number.NaN),
		draft: ((await page.getByTestId('fg-traces-draft').textContent()) ?? '').trim()
	}
}

export async function auditTraces(page, expected) {
	await clickThroughBusy(page.getByTestId('fg-audit'))
	await expect(page.getByTestId('fg-audit-applog')).toHaveText(String(expected), { timeout: 5_000 })
}

export async function surfaceCounts(page) {
	return page.getByTestId('fg-surface-row').evaluateAll((rows) => Object.fromEntries(rows.map((row) => [
		row.querySelector('[data-testid="fg-surface-name"]')?.textContent?.trim() ?? '',
		Number(row.querySelector('[data-testid="fg-surface-count"]')?.textContent?.trim())
	])))
}

export async function forget(page, expectedAppLog) {
	const result = page.getByTestId('fg-forget-result')
	await clickThroughBusy(page.getByTestId('fg-forget'), 10_000, true)
	await expect(result).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('fg-error')).toHaveCount(0)
	if (expectedAppLog !== undefined) {
		await expect.poll(async () => (await surfaceCounts(page)).appDemoLog, { timeout: 10_000 })
			.toBe(expectedAppLog)
	}
	await expect(page.getByTestId('fg-forget-ok')).toHaveText('true')
	const counts = await surfaceCounts(page)
	expect(Object.keys(counts).sort()).toEqual([...EXPECTED_SURFACES].sort())
	for (const count of Object.values(counts)) {
		expect(Number.isInteger(count)).toBe(true)
		expect(count).toBeGreaterThanOrEqual(0)
	}
	const rowsAffected = Number(await page.getByTestId('fg-forget-rows').textContent())
	expect(rowsAffected).toBe(Object.values(counts).reduce((sum, count) => sum + count, 0))
	return { counts, rowsAffected }
}

export async function displayedIdentity(page) {
	return ((await page.locator('header p').filter({ hasText: 'You are' }).textContent()) ?? '')
		.replace(/\s+/g, ' ')
		.trim()
}
