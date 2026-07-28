import { test, expect } from '@playwright/test'
import {
	openPrivacy,
	protectedSnapshot,
	rawState,
	roundState,
	submitMood,
	waitForDistinct,
	waitForFreshRound,
	waitForProtected
} from './privacy-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/privacy', () => {
	test('renders every mood action, aggregate state, privacy disclosure, and source link', async ({ page }) => {
		await openPrivacy(page)
		await expect(page.getByRole('heading', { name: 'Aggregate privacy: k-anonymity + differential privacy' })).toBeVisible()
		await expect(page.getByTestId('pv-picker-section')).toBeVisible()
		for (const [score, title] of [[1, 'rough'], [2, 'meh'], [3, 'okay'], [4, 'good'], [5, 'great']]) {
			const button = page.getByTestId(`pv-submit-${score}`)
			await expect(button).toBeVisible()
			await expect(button).toBeEnabled()
			await expect(button).toHaveAttribute('title', title)
			await expect(button).toContainText(String(score))
		}
		await expect(page.getByTestId('pv-raw-card')).toContainText('exact, every event')
		await expect(page.getByTestId('pv-protected-card')).toContainText('k = 3, Laplace noise')
		await expect(page.getByTestId('pv-explainer')).toContainText('k-anonymity')
		await expect(page.getByTestId('pv-explainer')).toContainText('tumbling window')
		await expect(page.getByRole('link', { name: 'privacy.js' })).toHaveAttribute('href', /src\/live\/demos\/privacy\.js$/)
		await expect(page.getByTestId('pv-submit-note')).toHaveCount(0)
		await expect(page.getByTestId('pv-error')).toHaveCount(0)
		expect((await roundState(page)).k).toBe(3)
	})

	test('one identity can drive all five moods while counting as only one contributor', async ({ page }) => {
		// Waiting out a round boundary can cost a minute; the assertions after it
		// are the point of the test and must not be skipped to save that time.
		test.setTimeout(120_000)
		await openPrivacy(page)
		// The contributor set is round-scoped and these specs are serial against
		// one shared cluster, so an inherited round can already sit at or above
		// k. Guarding the below-k assertions with `if (distinct < k)` let the
		// demo's central claim - the protected value is WITHHELD below k - go
		// unexercised while the test still reported green. Start from a round
		// this test actually controls instead.
		const initialRound = await waitForFreshRound(page)
		expect(initialRound.distinct).toBeLessThan(initialRound.k - 1)
		const initialRaw = await rawState(page)
		const protectedBefore = await protectedSnapshot(page)

		for (const score of [1, 2, 3, 4, 5]) await submitMood(page, score)
		const raw = await rawState(page)
		expect(raw.n).toBeGreaterThanOrEqual(initialRaw.n + 5)
		expect(raw.avg).toBeGreaterThanOrEqual(1)
		expect(raw.avg).toBeLessThanOrEqual(5)
		const round = await roundState(page)
		// Five submissions, exactly one new distinct contributor.
		expect(round.distinct).toBe(initialRound.distinct + 1)
		expect(round.distinct).toBeLessThan(round.k)
		await page.waitForTimeout(1_000)
		expect(await protectedSnapshot(page)).toBe(protectedBefore)
		await expect(page.getByTestId('pv-error')).toHaveCount(0)
	})

	test('fresh identities cross k and converge on one protected noisy value', async ({ browser }) => {
		const contexts = await Promise.all([
			browser.newContext(),
			browser.newContext(),
			browser.newContext()
		])
		const pages = await Promise.all(contexts.map((context) => context.newPage()))
		try {
			await Promise.all(pages.map((page) => openPrivacy(page)))
			const before = await protectedSnapshot(pages[0])
			let state = await roundState(pages[0])
			let crossed = state.distinct >= state.k

			for (let i = 0; i < pages.length; i++) {
				await submitMood(pages[i], i + 2)
				state = await roundState(pages[i])
				if (!crossed && state.distinct < state.k) {
					await pages[i].waitForTimeout(500)
					expect(await protectedSnapshot(pages[i])).toBe(before)
				}
				if (state.distinct >= state.k) crossed = true
			}

			// Confirm all three identities in one tight pass. If the minute
			// rolled over during the first pass, this re-earns k in the fresh
			// window; otherwise these are ordinary additional events from the
			// same already-distinct contributors.
			for (let i = 0; i < pages.length; i++) await submitMood(pages[i], 5 - i)
			await waitForDistinct(pages[0], 3)
			const protectedValues = await Promise.all(pages.map((page) => waitForProtected(page)))
			expect(new Set(protectedValues).size).toBe(1)
			for (const page of pages) await expect(page.getByTestId('pv-error')).toHaveCount(0)
		} finally {
			await Promise.allSettled(contexts.map((context) => context.close()))
		}
	})
})
