import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
import {
	assertSameRound,
	inStableRound,
	openPrivacy,
	pinRoundId,
	protectedSnapshot,
	rawState,
	roundState,
	RoundRolled,
	stageRollOnNextSubmit,
	STAGED_ROUND_STEP,
	submitMood,
	unpinRoundId,
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
		// A tumble landing mid-sequence buys a second attempt, and that attempt
		// waits out its own boundary first, so the ceiling covers two of them.
		test.setTimeout(240_000)
		await openPrivacy(page)
		// The contributor set is round-scoped and these specs are serial against
		// one shared cluster, so an inherited round can already sit at or above
		// k. Guarding the below-k assertions with `if (distinct < k)` let the
		// demo's central claim - the protected value is WITHHELD below k - go
		// unexercised while the test still reported green. Start from a round
		// this test actually controls instead.
		//
		// Every assertion below compares counts that are scoped to that one
		// round, so the sequence is retried rather than asserted across a
		// boundary: `n` restarting at 1 is indistinguishable from four lost
		// submissions if the window is allowed to change underneath it.
		await inStableRound(page, async (initialRound) => {
			expect(initialRound.distinct).toBeLessThan(initialRound.k - 1)
			const initialRaw = await rawState(page)
			const protectedBefore = await protectedSnapshot(page)

			for (const score of [1, 2, 3, 4, 5]) await submitMood(page, score)
			// The per-submission checks each guard their own poll; the totals
			// here span all five, so the boundary is re-checked across the whole
			// sequence before anything cumulative is asserted.
			await assertSameRound(page, initialRound.roundId, 'driving all five moods')
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

			// This test's subject is the round-scoped distinct count and the
			// agreement between replicas, not the running event total, so a
			// tumble costs it nothing and must not fail it. The crossing is
			// annotated on the report rather than swallowed.
			for (let i = 0; i < pages.length; i++) {
				await submitMood(pages[i], i + 2, { onRoll: 'skip' })
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
			for (let i = 0; i < pages.length; i++) await submitMood(pages[i], 5 - i, { onRoll: 'skip' })
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

	// The boundary this covers arrives at most once a minute and never on
	// demand, so left to chance it is exercised only occasionally - which is
	// how it reached the merge gate as a bare 'Expected: > 1  Received: 1'
	// with nothing naming a round. It is staged here instead, at the attribute
	// the helpers read, so the handling runs on every single run.
	//
	// Placed LAST, and asking for no cohort room, so it cannot influence the
	// tests above. It is the only test here that submits without asserting
	// anything about the cohort, and its two submissions would otherwise land
	// in the round the next test inherits - changing where that test starts
	// and what its baseline count means. A test that stages faults has to be
	// the one that absorbs their cost.
	test('a round boundary is named as a boundary and retried, not reported as lost submissions', async ({ page }) => {
		const anyRound = { minSecondsLeft: 1, requireRoom: false }
		await openPrivacy(page)

		// The id has to BE the aggregate's window index, not merely a number
		// that changes at about the right time - the whole point is that it
		// identifies the window scoping `n`. Both aggregates tumble on the UTC
		// minute, so the page's id must agree with the clock. Bracketed by two
		// readings because the test itself can straddle a boundary.
		const beforeMinute = Math.floor(Date.now() / 60_000)
		const start = await roundState(page)
		const afterMinute = Math.floor(Date.now() / 60_000)
		expect(start.roundId).toBeGreaterThanOrEqual(beforeMinute)
		expect(start.roundId).toBeLessThanOrEqual(afterMinute)

		// Detection: a crossing is reported as a crossing, naming both windows.
		const staged = start.roundId + STAGED_ROUND_STEP
		await pinRoundId(page, staged)
		await expect(assertSameRound(page, start.roundId, 'a staged crossing'))
			.rejects.toThrow(new RegExp(`rolled from ${start.roundId} to ${staged}`))
		await unpinRoundId(page)

		// Recovery: a crossing costs the attempt, not the test.
		const attemptsSeen = []
		const outcome = await inStableRound(page, async (round, attempt) => {
			attemptsSeen.push(attempt)
			if (attempt === 1) throw new RoundRolled(round.roundId, round.roundId + 1, 'a staged first attempt')
			return 'ran in the second window'
		}, { freshRound: anyRound })
		expect(attemptsSeen).toEqual([1, 2])
		expect(outcome).toBe('ran in the second window')

		// Exhaustion still fails - the retry must not turn a genuinely
		// unrunnable sequence into a silent pass - and it fails naming the
		// boundary rather than a count that looks like lost data.
		await expect(inStableRound(page, async (round) => {
			throw new RoundRolled(round.roundId, round.roundId + 1, 'a staged crossing')
		}, { attempts: 1, freshRound: anyRound })).rejects.toThrow(/rolled from \d+ to \d+/)

		// A sequence that never crosses must not be retried or altered.
		let ran = 0
		expect(await inStableRound(page, async () => { ran++; return 'clean' }, { freshRound: anyRound })).toBe('clean')
		expect(ran).toBe(1)

		// The submission helper is where this actually presented in the gate,
		// so its crossing path is exercised rather than reasoned about. The
		// staged roll lands after the starting read and before the raw count
		// settles, which is the real ordering.
		await stageRollOnNextSubmit(page)
		await expect(submitMood(page, 2)).rejects.toThrow(/rolled from \d+ to \d+/)
		await unpinRoundId(page)

		// The same crossing, for a caller whose subject does not span it, is
		// reported rather than raised - and it still says a crossing happened,
		// so a run that took the weaker path cannot look like a clean one.
		await stageRollOnNextSubmit(page)
		const tolerated = await submitMood(page, 3, { onRoll: 'skip' })
		expect(tolerated.rolled).toBe(true)
		await unpinRoundId(page)
		expect(test.info().annotations.filter((a) => a.type === 'round-rolled').length).toBeGreaterThan(0)
	})
})
