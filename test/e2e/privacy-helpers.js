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
 * Wait for a round that both has room for this test's contributor AND has
 * enough time left for the test to finish inside it.
 *
 * Two separate requirements, and only the first used to be enforced.
 *
 * Room: the contributor set is round-scoped and these specs run serially
 * against one shared cluster, so a test can inherit a round already at or above
 * k. Gating the below-k assertions on `if (distinct < k)` hides that - the test
 * goes green having never exercised the withholding the demo exists to show.
 * Waiting out the boundary makes those assertions unconditional.
 *
 * Time: the round is a wall-clock minute (`currentMinute()` in
 * `src/live/demos/privacy.js`), and EVERY round-scoped number resets when it
 * tumbles - including the raw `n` that `submitMood` asserts must increase. A
 * caller handed a round with three seconds left straddles the boundary
 * mid-sequence and sees n go 4 -> 1, which reads as a lost submission and is
 * really just a new window. This helper read `resetInSeconds` and never used
 * it; now it waits for a round with real headroom, so callers can assume one
 * window for their whole sequence and keep asserting monotonic counts.
 *
 * The default demands a round that has only JUST tumbled rather than merely
 * one with some time left. A five-submission sequence costs around 25 seconds
 * because each submission waits for an aggregate publish, so "20 seconds
 * remaining" still straddles; the only reliable window is a fresh one. Both
 * conditions come true together at every tumble - distinct resets to 0 as the
 * clock resets to 60 - so this waits at most one round. `resetInSeconds` is
 * refreshed on the page every 5s, hence 50 rather than 60.
 */
export async function waitForFreshRound(page, { timeout = 90_000, minSecondsLeft = 50 } = {}) {
	const usable = (s) => s.distinct < s.k - 1 && s.resetInSeconds >= minSecondsLeft
	const state = await roundState(page)
	if (usable(state)) return state
	await expect.poll(async () => usable(await roundState(page)), {
		timeout,
		intervals: [1_000]
	}).toBe(true)
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
