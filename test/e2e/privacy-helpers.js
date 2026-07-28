import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openPrivacy(page, url = '/demos/privacy') {
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('pv-round-hint')).toBeVisible({ timeout: 10_000 })
}

export async function roundState(page) {
	return {
		distinct: Number(await page.getByTestId('pv-round-distinct').textContent()),
		k: Number(await page.getByTestId('pv-round-k').textContent()),
		resetInSeconds: Number(await page.getByTestId('pv-round-reset').textContent())
	}
}

/**
 * Wait until the round has room for this test's contributor without reaching k.
 *
 * The contributor set is round-scoped and tumbles every minute, and these specs
 * run serially against one shared cluster, so a test can inherit a round that is
 * already at or above k. Gating the below-k assertions on `if (distinct < k)`
 * hides that: the test goes green having never exercised the withholding the
 * demo exists to show. Waiting out the boundary makes those assertions
 * unconditional. The page refreshes the round every 5s, so poll rather than
 * trusting a single read of resetInSeconds.
 */
export async function waitForFreshRound(page, timeout = 90_000) {
	const state = await roundState(page)
	if (state.distinct < state.k - 1) return state
	await expect.poll(async () => (await roundState(page)).distinct, {
		timeout,
		intervals: [1_000]
	}).toBeLessThan(state.k - 1)
	return roundState(page)
}

export async function rawState(page) {
	if (await page.getByTestId('pv-raw-n').count() === 0) return { n: 0, avg: null }
	return {
		n: Number(await page.getByTestId('pv-raw-n').textContent()),
		avg: Number(await page.getByTestId('pv-raw-avg').textContent())
	}
}

export async function protectedSnapshot(page) {
	return (await page.getByTestId('pv-protected-value-area').innerText()).replace(/\s+/g, ' ').trim()
}

export async function submitMood(page, score) {
	const before = (await rawState(page)).n
	await page.getByTestId(`pv-submit-${score}`).click()
	await expect(page.getByTestId('pv-submit-note')).toContainText(`Submitted ${score}/5`)
	await expect(page.getByTestId(`pv-submit-${score}`)).toHaveClass(/btn-primary/)
	await expect.poll(async () => (await rawState(page)).n, { timeout: 10_000 }).toBeGreaterThan(before)
}

export async function waitForDistinct(page, expected) {
	await expect.poll(async () => (await roundState(page)).distinct, { timeout: 10_000 })
		.toBeGreaterThanOrEqual(expected)
}

export async function waitForProtected(page) {
	await expect(page.getByTestId('pv-protected-value')).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('pv-protected-n')).toBeVisible()
	return protectedSnapshot(page)
}
