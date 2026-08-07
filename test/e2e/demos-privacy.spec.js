import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
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
		for (const [score, label] of [[1, 'rough'], [2, 'meh'], [3, 'okay'], [4, 'good'], [5, 'great']]) {
			const button = page.getByTestId(`pv-submit-${score}`)
			await expect(button).toBeVisible()
			await expect(button).toBeEnabled()
			// The scale label is visible text and an accessible name now, not
			// a hover-only title that touch and screen readers never got.
			await expect(page.getByTestId(`pv-mood-label-${score}`)).toHaveText(label)
			await expect(button).toHaveAttribute('aria-label', `${label} - ${score} of 5`)
		}
		// The action leads on a phone; the spec prose is one tap away.
		await expect(page.getByTestId('pv-lede')).toContainText('Pick a mood below')
		await expect(page.getByTestId('pv-mechanism-toggle')).toBeVisible()
		await expect(page.getByTestId('pv-invite')).toBeEnabled()
		await expect(page.getByTestId('pv-raw-card')).toContainText('exact, every event')
		await expect(page.getByTestId('pv-protected-card')).toContainText('k = 3, Laplace noise')
		await expect(page.getByTestId('pv-explainer')).toContainText('k-anonymity')
		await expect(page.getByTestId('pv-explainer')).toContainText('tumbling window')
		await expect(page.getByRole('link', { name: 'privacy.js' })).toHaveAttribute('href', /src\/live\/demos\/privacy\.js$/)
		await expect(page.getByTestId('pv-submit-note')).toHaveCount(0)
		await expect(page.getByTestId('pv-error')).toHaveCount(0)
		// The distinct-contributor number comes from the demo-only roundInfo()
		// endpoint, NOT from the raw aggregate: raw exposes an event count and
		// never a distinct-contributor count. The page used to credit raw,
		// which on the one unit chaired for honesty had it contradicting its
		// own "the protected output alone never reveals its cohort size"
		// claim. Pinned so the attribution cannot drift back.
		await expect(page.getByTestId('pv-round-hint')).toContainText('demo-only')
		await expect(page.getByTestId('pv-round-hint')).toContainText('roundInfo()')
		await expect(page.getByTestId('pv-round-hint')).toContainText('the protected output never reveals it')
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

	test('a solo visitor can reach the payoff: simulated contributors cross k through the real gate', async ({ page }) => {
		test.setTimeout(120_000)
		await openPrivacy(page)
		// Start from a round this test controls, so the k crossing below is
		// genuinely caused here rather than inherited.
		const fresh = await waitForFreshRound(page)
		expect(fresh.distinct).toBeLessThan(fresh.k)

		// One human, then two stand-ins: exactly the situation the page
		// previously answered with "open two more browsers".
		//
		// Submitted directly rather than through the submitMood helper: that
		// helper asserts the RAW count increases, and the raw card keeps
		// displaying the previous window's value until the new window's first
		// publish lands - so across a tumble it can read 11 and then 1 and
		// fail on a submission that was never lost. This test's subject is
		// the round-scoped distinct count, which resets cleanly with the
		// round, so it asserts that instead of borrowing an oracle it does
		// not need.
		await page.getByTestId('pv-submit-4').click()
		await expect(page.getByTestId('pv-submit-note')).toContainText('Submitted 4/5')
		const afterSelf = await roundState(page)
		expect(afterSelf.distinct).toBe(fresh.distinct + 1)
		expect(afterSelf.distinct).toBeLessThan(afterSelf.k)

		await page.getByTestId('pv-invite').click()
		await expect(page.getByTestId('pv-invite')).toBeEnabled()
		// The gate is crossed by real distinct contributors, so the protected
		// aggregate publishes for the first time and the held state retires.
		await waitForDistinct(page, 3)
		// waitForProtected returns the card's TEXT snapshot (that is how the
		// multi-tab test compares replicas), so read the value element for a
		// numeric assertion rather than coercing the snapshot.
		await waitForProtected(page)
		const published = Number(await page.getByTestId('pv-protected-value').textContent())
		expect(Number.isFinite(published)).toBe(true)
		await expect(page.getByTestId('pv-protected-held')).toHaveCount(0)
		// The published caption carries the page's most interesting encoding:
		// the submission COUNT is noised too, which is why it can read
		// fractionally. It used to say "noisy average of a noisy N
		// submissions", which parses as a typo and made the fractional count
		// look like a bug rather than the point. Asserted HERE rather than on
		// load because the caption only exists once something has actually
		// published - before that the card renders pv-protected-held instead,
		// so an on-load assertion would be asserting against the wrong branch.
		await expect(page.getByTestId('pv-protected-value-area'))
			.toContainText('Noise is added to the average and to the submission count alike')
		await expect(page.getByTestId('pv-error')).toHaveCount(0)
	})

	test('the countdown ticks every second instead of jumping with the poll', async ({ page }) => {
		await openPrivacy(page)
		const read = async () => Number(await page.getByTestId('pv-round-reset').textContent())
		const first = await read()
		// A 5s poll with no interpolation holds the same number for seconds
		// at a time; a per-second tick has moved well before the next poll.
		await expect.poll(read, { timeout: 4_000 }).toBeLessThan(first)
	})

	test('mood buttons meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openPrivacy(page)
			for (const score of [1, 2, 3, 4, 5]) {
				await expectTouchTarget(page.getByTestId(`pv-submit-${score}`))
			}
		} finally {
			await context.close()
		}
	})

	// At 360x640, 320x568 and 844x390 the first viewport used to show only the
	// title and a nine-line spec paragraph, with the picker entirely below the
	// fold - on a unit whose visitor-success line begins "submit a mood", the
	// page opened with no visible action and invited a bounce before the demo
	// was ever exercised.
	//
	// Asserting the lede's TEXT proves the copy changed; it does not prove the
	// action became reachable, which is what the finding actually claimed. So
	// this measures the action itself, at the three rungs the finding named.
	test('the primary action is above the fold on every phone rung named in the finding', async ({ browser }) => {
		for (const [width, height] of [[360, 640], [320, 568], [844, 390]]) {
			const context = await browser.newContext({ viewport: { width, height } })
			const page = await context.newPage()
			try {
				await openPrivacy(page)
				// "Above the fold" is a claim about what the visitor sees
				// before touching anything, so a test that had scrolled first
				// would be answering a different question. Assert the starting
				// position rather than assuming it.
				expect(
					await page.evaluate(() => window.scrollY),
					`${width}x${height} did not start at the top of the document`
				).toBe(0)
				// ratio 1, not mere intersection: a single visible pixel of the
				// first button would satisfy toBeInViewport() while still
				// leaving the action effectively unreachable.
				await expect(
					page.getByTestId('pv-submit-1'),
					`the first mood button is not fully inside the first viewport at ${width}x${height}`
				).toBeInViewport({ ratio: 1 })
			} finally {
				await context.close()
			}
		}
	})
})
