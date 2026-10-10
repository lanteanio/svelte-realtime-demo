import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
import {
	assertSameRound,
	inStableRound,
	openPrivacy,
	pinRawCount,
	pinReadout,
	pinRoundId,
	protectedSnapshot,
	rawState,
	RETRIED_SEQUENCE_TIMEOUT,
	roundState,
	RoundRolled,
	stageRollOnNextSubmit,
	STAGED_ROUND_STEP,
	submitMood,
	unpinRawCount,
	unpinReadouts,
	unpinRoundId,
	waitForDistinct,
	waitForFreshRound,
	waitForProtected,
	windowRawCount
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
		// Sized for the retry: a tumble landing mid-sequence buys a second
		// attempt, which starts about two rounds later. The assertions after the
		// waits are the point of the test and must not be skipped to save the
		// time.
		test.setTimeout(RETRIED_SEQUENCE_TIMEOUT)
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
			const initialRaw = await windowRawCount(page)
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
	// action became reachable, which is what actually matters. So this
	// measures the action itself, at three phone rungs.
	test('the primary action is above the fold on every phone rung', async ({ browser }) => {
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

	test('a fresh round is one that has run a few seconds, not one that has just turned over', async ({ page }) => {
		// Two passes, each of which can spend its helper's 20 s poll, then a
		// restore check that can wait 15 s for a countdown of 5 or more and
		// holds its pin for 3 s.
		test.setTimeout(75_000)
		await openPrivacy(page)
		// The countdown is the only reading the minSecondsIn condition takes,
		// so it is staged there: 58 is one reading short of what the default
		// accepts, and 57 the first it does. Run without room required and
		// with it; with it, the contributor count is staged at 0 so the room
		// condition holds whatever the real round holds. Nothing is submitted.
		try {
			for (const requireRoom of [false, true]) {
				if (requireRoom) await pinReadout(page, 'pv-round-distinct', 0)
				await pinReadout(page, 'pv-round-reset', 58)
				const waited = waitForFreshRound(page, { requireRoom, timeout: 20_000 })
				// The helper re-reads once a second, so it has read 58 at least
				// twice before the pin moves, as long as the pin held.
				await page.waitForTimeout(3_000)
				expect(await page.getByTestId('pv-round-reset').textContent(), 'the staged 58 must still be showing').toBe('58')
				await pinReadout(page, 'pv-round-reset', 57)
				expect((await waited).resetInSeconds, `requireRoom: ${requireRoom}`).toBe(57)
			}
			// No reading satisfies both bounds at once, so the helper refuses
			// them before it reads anything.
			await expect(waitForFreshRound(page, { minSecondsLeft: 58 })).rejects.toThrow(/exceeds the 60 s round/)
			// Released, a readout shows the text the page last wrote to it. The
			// test watches the readout with an observer of its own, installed
			// before the first pin, each record holding the text a change
			// replaced, so a change's new text is the next record's old one. The
			// first change to 99 is the pin taking hold, and the text it replaced
			// is the one pinReadout must return. The page's writes while pinned
			// are the changes from a pinned text to one that is not pinned, and
			// the release is the last such change: it must put back the text of
			// the one before it. The countdown moves on every tick, so in three
			// seconds pinned the page writes at least twice, as long as it starts
			// at 5 or more, where it cannot reach 0 and stop. The pinned texts, 99
			// and 98, are ones a countdown cannot show; the second pin moves the
			// first.
			await unpinReadouts(page)
			await expect.poll(async () => (await roundState(page)).resetInSeconds, { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
			const pinned = ['99', '98']
			await page.evaluate(() => {
				const text = document.querySelector('[data-testid="pv-round-reset"]')?.firstChild
				const replaced = (window.__pvResetReplaced = [])
				const watch = (window.__pvResetWatch = new MutationObserver((records) => {
					for (const record of records) replaced.push(record.oldValue)
				}))
				watch.observe(text, { characterData: true, characterDataOldValue: true })
			})
			const found = await pinReadout(page, 'pv-round-reset', pinned[0])
			await page.waitForTimeout(3_000)
			const foundMoved = await pinReadout(page, 'pv-round-reset', pinned[1])
			await unpinReadouts(page)
			const { replaced, current } = await page.evaluate(() => {
				const replaced = window.__pvResetReplaced
				for (const record of window.__pvResetWatch.takeRecords()) replaced.push(record.oldValue)
				window.__pvResetWatch.disconnect()
				delete window.__pvResetWatch
				delete window.__pvResetReplaced
				return { replaced, current: document.querySelector('[data-testid="pv-round-reset"]')?.textContent }
			})
			expect(pinned, 'unpinning must not leave a pinned text showing').not.toContain(current)
			const changes = replaced.map((old, i) => [old, replaced[i + 1] ?? current])
			expect(changes.find(([, text]) => text === pinned[0])?.[0], 'pinReadout must return the text its pin replaced')
				.toBe(found)
			const fromPinned = changes
				.filter(([old, text]) => pinned.includes(old) && !pinned.includes(text))
				.map(([, text]) => text)
			const putBack = fromPinned.at(-1)
			const pageWrites = fromPinned.slice(0, -1)
			expect(pageWrites.length, 'the page must have written to the pinned readout at least twice').toBeGreaterThanOrEqual(2)
			expect(putBack, 'unpinning must put back the text the page last wrote while pinned').toBe(pageWrites.at(-1))
			// Moving the pin returns what the page last wrote before the move:
			// the last change from 99 to a text that is not pinned before the
			// change from 99 to 98, or the text the first pin replaced.
			const moved = changes.findIndex(([old, text]) => old === pinned[0] && text === pinned[1])
			const writtenBeforeMove = changes.slice(0, moved)
				.filter(([old, text]) => pinned.includes(old) && !pinned.includes(text))
				.map(([, text]) => text)
			expect(moved, 'the second pin must have taken hold').toBeGreaterThan(-1)
			expect(foundMoved, 'a moved pin must return the text the page last wrote before the move').toBe(writtenBeforeMove.at(-1) ?? found)
		} finally {
			await unpinReadouts(page)
		}
	})

	test('releasing a round id pin puts back the last id the page wrote, on either pin path', async ({ page }) => {
		await openPrivacy(page)
		await waitForFreshRound(page, { requireRoom: false, minSecondsLeft: 10 })
		const hint = page.getByTestId('pv-round-hint')
		const real = Number(await hint.getAttribute('data-round-id'))
		// A write from the test stands in for the framework's own at a tumble,
		// which takes up to a minute to arrive: the attribute observer cannot
		// tell the two apart.
		const pageWrites = (id) => page.evaluate((value) => {
			document.querySelector('[data-testid="pv-round-hint"]').setAttribute('data-round-id', value)
		}, String(id))
		try {
			await pinRoundId(page, real + STAGED_ROUND_STEP)
			await pageWrites(real + 1)
			expect(await hint.getAttribute('data-round-id'), 'the pin must hold over a page write').toBe(String(real + STAGED_ROUND_STEP))
			await unpinRoundId(page)
			expect(await hint.getAttribute('data-round-id'), 'releasing must put back the id the page last wrote, not the one from when the pin was placed')
				.toBe(String(real + 1))

			// The staged path pins when a mood button's click lands. The click is
			// stopped at the button, so the page's own handler never runs and
			// nothing is submitted.
			const click = () => page.evaluate(() => {
				const button = document.querySelector('[data-testid="pv-submit-3"]')
				button.addEventListener('click', (event) => event.stopImmediatePropagation(), { capture: true, once: true })
				button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			})
			await expect(page.getByTestId('pv-submit-3')).toBeEnabled()
			await stageRollOnNextSubmit(page)
			await click()
			expect(await hint.getAttribute('data-round-id'), 'the staged pin must take hold on the click').toBe(String(real + 1 + STAGED_ROUND_STEP))
			await pageWrites(real + 2)
			expect(await hint.getAttribute('data-round-id'), 'the staged pin must hold over a page write').toBe(String(real + 1 + STAGED_ROUND_STEP))
			await unpinRoundId(page)
			expect(await hint.getAttribute('data-round-id'), 'releasing a staged pin must put back the id the page last wrote').toBe(String(real + 2))

			// Released before its click, a stage never takes hold.
			await stageRollOnNextSubmit(page)
			await unpinRoundId(page)
			await click()
			expect(await hint.getAttribute('data-round-id'), 'a stage released before its click must not pin on a later one').toBe(String(real + 2))

			await pinRoundId(page, real + STAGED_ROUND_STEP)
			await unpinRoundId(page)
			await pageWrites(real + 3)
			await pinRoundId(page, real + STAGED_ROUND_STEP + 1)
			await unpinRoundId(page)
			expect(await hint.getAttribute('data-round-id'), 'a fresh pin after a release must record the attribute it finds')
				.toBe(String(real + 3))
		} finally {
			await unpinRoundId(page)
		}
	})

	test('a retry after a crossing waits for a round later than the latest one the crossing reached', async ({ page }) => {
		// The guard's own wait for that later round is what is under test, so
		// the rounds are staged on the readout's id. Room and a fresh countdown
		// are staged too, so the real round's state decides nothing. Nothing is
		// submitted.
		//
		// One case per way an attempt can end once the round has moved: a
		// crossing the step throws, once naming a round ahead of the one the
		// page shows and once a round behind it, an ordinary failure, and a
		// pass. While the retry waits, the page's id moves to the latest of
		// those rounds, still not past it (at `latestAt`), and only then one
		// further (at `pastAt`), so a retry that took an earlier id as the one
		// reached starts early. The retry must also start within 2 s of the
		// move past, and the moves past come 4.5, 7, 2 and 12 s after the
		// attempt ends, each more than 2 s from every other: no fixed delay
		// falls within 2 s after two of them, so a retry that slept instead of
		// waiting for the round fails at least one case. The pinned id does not
		// change sooner than 2 s after the attempt ends, so the guard's own
		// re-read of the page, which a changed id would mislead, has that long
		// to land. About 30 s in all.
		test.setTimeout(60_000)
		await openPrivacy(page)
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
		const cases = [
			{ ends: 'a crossing thrown naming a round ahead of the page', shows: 0, names: 2, latestAt: 2_000, pastAt: 4_500 },
			{ ends: 'a crossing thrown naming a round behind the page', shows: 2, names: 0, latestAt: 0, pastAt: 7_000 },
			{ ends: 'an ordinary failure', shows: 0, fails: true, latestAt: 0, pastAt: 2_000 },
			{ ends: 'a pass', shows: 0, latestAt: 0, pastAt: 12_000 }
		]
		await pinReadout(page, 'pv-round-distinct', 0)
		await pinReadout(page, 'pv-round-reset', 55)
		let moving = Promise.resolve()
		try {
			for (const { ends, shows, names, fails, latestAt, pastAt } of cases) {
				const starts = []
				let staged = []
				let movedPastAt = 0
				let retriedAt = 0
				const outcome = await inStableRound(page, async (round, attempt) => {
					starts.push(round.roundId)
					if (attempt > 1) {
						retriedAt = Date.now()
						return 'ran'
					}
					const base = round.roundId + STAGED_ROUND_STEP
					const latest = base + Math.max(shows, names ?? shows)
					staged = [base + shows, latest, latest + 1]
					await pinRoundId(page, base + shows)
					moving = (async () => {
						await sleep(latestAt)
						await pinRoundId(page, latest)
						await sleep(pastAt - latestAt)
						// Taken before the pin is applied, so no read of the id it
						// pins can come earlier.
						movedPastAt = Date.now()
						await pinRoundId(page, latest + 1)
					})()
					if (names !== undefined) throw new RoundRolled(round.roundId, base + names, 'a staged crossing')
					if (fails) throw new Error('a staged ordinary failure')
					return 'passed across the boundary'
				})
				await moving
				expect(outcome, ends).toBe('ran')
				expect(starts.slice(1), `after ${ends}, the retry must start past the latest round reached`).toEqual([staged.at(-1)])
				expect(retriedAt - movedPastAt, `after ${ends}, the retry must start within 2 s of the round moving past the latest one reached`)
					.toBeLessThanOrEqual(2_000)
				// Each move of the pin must replace the one before. A pin left
				// running would keep writing its id after the release.
				await unpinRoundId(page)
				await page.waitForTimeout(200)
				expect(staged, `after ${ends}, no pin may outlive the release`)
					.not.toContain(Number(await page.getByTestId('pv-round-hint').getAttribute('data-round-id')))
			}
		} finally {
			await moving.catch(() => {})
			await unpinRoundId(page)
			await unpinReadouts(page)
		}
	})

	// The boundary this covers arrives at most once a minute and never on
	// demand, so left to chance it is exercised only occasionally - which is
	// how it reached the merge gate as a bare 'Expected: > 1  Received: 1'
	// with nothing naming a round. It is staged here instead, at the attribute
	// the helpers read, so the handling runs on every single run.
	//
	// Placed after every test that asserts anything about the cohort, and
	// asking for no cohort room, so it cannot influence them. Its two
	// submissions assert nothing about the cohort, and would otherwise land in
	// the round a cohort test inherits - changing where that test starts and
	// what its baseline count means. The tests after it submit nothing, or
	// wait for a fresh round and assert no cohort. A test that stages faults
	// has to be the one that absorbs their cost.
	test('a round boundary is named as a boundary and retried, not reported as lost submissions', async ({ page }) => {
		// Owns several fresh-round waits and two real submissions; the default
		// 30s budget leaves no room for an unlucky wall-clock phase.
		test.setTimeout(120_000)
		const anyRound = { minSecondsLeft: 1, requireRoom: false }
		// The guard records every crossing it absorbs; each path is checked for
		// its own note, since a count of all of them passes with any one missing.
		const rollNotes = () => test.info().annotations.filter((a) => a.type === 'round-rolled').map((a) => a.description)
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
		expect(rollNotes().filter((d) => /^attempt 1 of 2: the privacy round rolled from \d+ to \d+ while a staged first attempt\./.test(d)),
			'a detected crossing must be recorded on the report as itself').toHaveLength(1)

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

		// A failure the boundary EXPLAINS is converted to a retry. Most steps
		// of a round-scoped sequence never read the round id: a poll on a
		// count the tumble reset fails as an ordinary timeout, not as a
		// RoundRolled, and aborting the sequence on it is the boundary killing
		// the test through a side door. The staged crossing makes the guard's
		// re-read see a moved round while the thrown error knows nothing of
		// rounds at all.
		const conversions = []
		const converted = await inStableRound(page, async (round, attempt) => {
			conversions.push(attempt)
			if (attempt === 1) {
				await pinRoundId(page, round.roundId + STAGED_ROUND_STEP)
				throw new Error('a poll timed out reading a count the tumble reset')
			}
			return 'ran after the conversion'
		}, { freshRound: anyRound })
		await unpinRoundId(page)
		expect(conversions, 'an explained failure must cost the attempt, not the test').toEqual([1, 2])
		expect(converted).toBe('ran after the conversion')
		expect(rollNotes().filter((d) => /^attempt 1 of 2: .*whose failure the boundary explains: a poll timed out/.test(d)),
			'the conversion must be recorded on the report').toHaveLength(1)

		// The conversion ends the attempt there. With no retry left, the
		// converted failure is what surfaces, still naming the step that
		// failed; one that fell through to the success check would read the
		// pinned id as a pass that moved and report that instead. The staged
		// failure is shaped like the expect.poll failures the helpers throw: a
		// coloured matcher line, its Expected and Received values, and the
		// "Call Log:" block Playwright appends to a poll. It must be quoted
		// without the colours and without that block, which would bury the
		// boundary's own sentence. (A locator failure's lower-case "Call log:"
		// is cut in the test of a page that cannot show the round.)
		const exhausted = await inStableRound(page, async (round) => {
			await pinRoundId(page, round.roundId + STAGED_ROUND_STEP)
			throw new Error(
				'\x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m\x1b[2m).\x1b[22mtoBeGreaterThanOrEqual\x1b[2m(\x1b[22m\x1b[32mexpected\x1b[39m\x1b[2m)\x1b[22m\n\n' +
				'Expected: >= \x1b[32m2\x1b[39m\nReceived:    \x1b[31m1\x1b[39m\n\nCall Log:\n- Timeout 10000ms exceeded while waiting on the predicate'
			)
		}, { attempts: 1, freshRound: anyRound }).then(() => null, (error) => error)
		await unpinRoundId(page)
		expect(exhausted?.message).toMatch(/whose failure the boundary explains: expect\(received\)\.toBeGreaterThanOrEqual\(expected\)\s+Expected: >= 2\s+Received: +1\. Every count/)
		expect(exhausted?.message).not.toContain('\x1b[')
		expect(exhausted?.to - exhausted?.from, 'the crossing names the window it moved to').toBe(STAGED_ROUND_STEP)

		// A sequence that PASSES across a boundary is no pass either: the
		// counts reset at the tumble, so its assertions can come out right on
		// readings from two windows. With no retry left it fails as a
		// crossing...
		const refused = await inStableRound(page, async (round) => {
			await pinRoundId(page, round.roundId + STAGED_ROUND_STEP)
			return 'passed across the boundary'
		}, { attempts: 1, freshRound: anyRound }).then(() => null, (error) => error)
		await unpinRoundId(page)
		expect(refused?.message).toMatch(/rolled from \d+ to \d+ while a round-scoped sequence ran to a pass/)
		expect(refused?.to - refused?.from, 'the refusal names the window the pass ended in').toBe(STAGED_ROUND_STEP)

		// ...and by default it costs the attempt. The second attempt starts in
		// the staged round and stays in it, so it is the one returned.
		const passes = []
		const repeated = await inStableRound(page, async (round, attempt) => {
			passes.push(attempt)
			if (attempt === 1) await pinRoundId(page, round.roundId + STAGED_ROUND_STEP)
			return `attempt ${attempt}`
		}, { freshRound: anyRound })
		await unpinRoundId(page)
		expect(passes, 'a pass spanning two windows must cost the attempt').toEqual([1, 2])
		expect(repeated).toBe('attempt 2')
		expect(rollNotes().filter((d) => /^attempt 1 of 2: .*while a round-scoped sequence ran to a pass/.test(d)),
			'a pass the guard refuses must be recorded on the report').toHaveLength(1)

		// And the conversion is evidence-gated: the same ordinary failure in a
		// round that did NOT move stays loud and unretried, because a retry on
		// an unexplained failure would be a real bug getting a second chance
		// to pass. Headroom is asked for so a real tumble cannot land inside
		// this block and explain the failure by accident.
		let plainRuns = 0
		const realFailure = new Error('a real failure in a stable round')
		const plain = await inStableRound(page, async () => {
			plainRuns++
			throw realFailure
		}, { freshRound: { minSecondsLeft: 5, requireRoom: false } }).then(() => null, (error) => error)
		expect(plainRuns, 'an unexplained failure must not be retried').toBe(1)
		// Surfaced as itself, the very error thrown: a converted one or a copy
		// would carry the same text.
		expect(plain).toBe(realFailure)

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
		expect(rollNotes().filter((d) => /^the privacy round rolled from \d+ to \d+ while waiting for the raw aggregate to count a 3\/5 submission/.test(d)),
			'a tolerated crossing must be recorded on the report').toHaveLength(1)
	})

	test('a sequence that leaves its page unable to show the round is reported by its own outcome, not by a stalled guard', async ({ page }) => {
		// Three bounded re-reads run out here, all on `leaving` after it has
		// navigated away; a closed page's reads reject at once.
		test.setTimeout(90_000)
		const anyRound = { minSecondsLeft: 1, requireRoom: false }
		const context = page.context()
		const outcomeOf = (sequence) => sequence.then(() => null, (error) => error)

		// Closed: every read of it rejects at once.
		const closing = await context.newPage()
		await openPrivacy(closing)
		const closedFailure = new Error('the step that failed')
		expect(await outcomeOf(inStableRound(closing, async () => {
			await closing.close()
			throw closedFailure
		}, { attempts: 1, freshRound: anyRound }))).toBe(closedFailure)

		// Navigated away: the page still answers, the readout is just gone, so
		// an unbounded read would wait for it until the test timed out.
		const leaving = await context.newPage()
		await openPrivacy(leaving)
		const leftFailure = new Error('the step that failed')
		expect(await outcomeOf(inStableRound(leaving, async () => {
			await leaving.goto('about:blank')
			throw leftFailure
		}, { attempts: 1, freshRound: anyRound }))).toBe(leftFailure)

		// A crossing the step detected itself, with an attempt still left, is
		// what the guard ends with when its page can no longer show the round.
		// Otherwise the next attempt's fresh-round wait would take over: on a
		// page that navigated away it never returns, and on a closed page it
		// fails at once with a Playwright error in place of the crossing.
		// Each crossing is also on the report, as the note the guard writes for
		// attempt 1 of 2, although no attempt follows it.
		const rollNotes = () => test.info().annotations.filter((a) => a.type === 'round-rolled').map((a) => a.description)
		const closingAgain = await context.newPage()
		await openPrivacy(closingAgain)
		let closedCrossing
		expect(await outcomeOf(inStableRound(closingAgain, async (round) => {
			closedCrossing = new RoundRolled(round.roundId, round.roundId + 1, 'a crossing the step detected on a page it closed')
			await closingAgain.close()
			throw closedCrossing
		}, { freshRound: anyRound }))).toBe(closedCrossing)
		expect(rollNotes().filter((note) => note === `attempt 1 of 2: ${closedCrossing.message}`),
			'a crossing on a page that closed must be recorded on the report, once').toHaveLength(1)
		await openPrivacy(leaving)
		let leftCrossing
		expect(await outcomeOf(inStableRound(leaving, async (round) => {
			leftCrossing = new RoundRolled(round.roundId, round.roundId + 1, 'a crossing the step detected on a page it left')
			await leaving.goto('about:blank')
			throw leftCrossing
		}, { freshRound: anyRound }))).toBe(leftCrossing)
		expect(rollNotes().filter((note) => note === `attempt 1 of 2: ${leftCrossing.message}`),
			'a crossing on a page that navigated away must be recorded on the report, once').toHaveLength(1)

		// A pass the guard cannot place in one window is not returned.
		await openPrivacy(leaving)
		await expect(inStableRound(leaving, async () => {
			await leaving.goto('about:blank')
			return 'passed somewhere else'
		}, { attempts: 1, freshRound: anyRound })).rejects.toThrow(/passed, but the round could not be re-read to confirm it ran in one window: locator\.getAttribute: Timeout \d+ms exceeded\.$/)
		await leaving.close()
	})

	test('a submission the page never applies is reported as published, not as missing', async ({ page }) => {
		// The fresh-round wait below qualifies only in the first seconds of a
		// minute, so an unlucky wall-clock phase legitimately costs most of
		// one; the default 30s budget turned that phase into a coin flip.
		test.setTimeout(120_000)
		// The gap this closes is the ENRICHMENT path itself. The helper's other
		// failure route - a round boundary - is raised after the poll succeeds and
		// never enters the catch, so nothing until now drove the branch that
		// attaches the wire verdict to a real timeout.
		await openPrivacy(page)
		// Headroom, so the ten-second poll below fails on the aggregate rather
		// than straddling a boundary and raising the other error entirely.
		await waitForFreshRound(page, { requireRoom: false })
		// One counted submission first, so the card shows this window's count.
		// Frozen at that count, the card cannot equal the next publish's n, which
		// is one more; frozen at an earlier window's count it could.
		await submitMood(page, 4)

		// Stage the one fault the count cannot distinguish on its own: the write
		// is accepted, the aggregate publishes, the frames arrive, and the page
		// does not apply them. Freezing the readout produces exactly that, and it
		// leaves the socket untouched - intercepting it would trip the guard that
		// makes the report decline to speak, which is the opposite of the verdict
		// under test.
		const frozen = await pinRawCount(page)
		try {
			const failure = await submitMood(page, 3).then(() => null, (error) => error)
			expect(failure, 'a frozen readout must fail the poll').not.toBeNull()
			expect(failure.message, 'the timeout must carry the wire verdict').toContain('--- aggregate probe ---')
			// The counts the helper reports are the staged ones, which is what ties
			// the message to the staged condition rather than to any old failure:
			// the card held the frozen count throughout while the newest frame
			// carried one more. The frozen count arrived in this window, so it is
			// also the baseline.
			expect(failure.message).toContain(`card before the click: ${frozen}\n`)
			expect(failure.message).toContain(`card after the poll: ${frozen}\n`)
			expect(failure.message).toContain(`newest frame since the mark: n ${Number(frozen) + 1}\n`)
			expect(failure.message, 'the baseline is this window\'s count').toContain(`the baseline was ${frozen}\n`)

			// The verdict, and the three readings it must not reach, each excluded
			// by name. Matched with startsWith rather than a substring test,
			// because 'NEVER PUBLISHED:' CONTAINS 'PUBLISHED:' - the cheap check is
			// satisfied by the exact opposite answer.
			const verdict = (failure.message.split('--- aggregate probe ---')[1] ?? '').trim()
			expect(verdict.startsWith('PUBLISHED:'), `the verdict must be the published one, got: ${verdict.slice(0, 40)}`).toBe(true)
			expect(verdict, 'the published verdict names how many frames arrived').toContain('frame(s) arrived on')
			expect(Number(verdict.slice('PUBLISHED: '.length).split(' ')[0]), 'at least one frame must be counted').toBeGreaterThan(0)
			expect(
				failure.message,
				'frames did arrive, so the never-published reading would be false'
			).not.toContain('NEVER PUBLISHED')
			expect(failure.message, 'this spec does not intercept the socket').not.toContain('SOCKET ROUTED')
			expect(failure.message, 'the record was armed before the navigation').not.toContain('NO EVIDENCE')
		} finally {
			await unpinRawCount(page)
		}
	})

	test('a submission is judged by its window and by the newest frame, not by the card alone', async ({ page }) => {
		// The fresh-round wait can take most of a minute.
		test.setTimeout(120_000)
		await openPrivacy(page)
		await waitForFreshRound(page, { requireRoom: false })
		const submitted = Date.now()
		await submitMood(page, 4)
		const counted = Date.now()
		const shown = Number(await page.getByTestId('pv-raw-n').textContent())
		await page.waitForTimeout(500)
		// The count's arrival is the time its frame came in during the
		// submission, not the time it is read. It came in this minute, so it is
		// this window's; read as of a minute later, the same count is an
		// earlier window's.
		const now = await windowRawCount(page)
		expect(now.arrivedAt, 'the count arrived during its submission').toBeGreaterThanOrEqual(submitted)
		expect(now.arrivedAt, 'the count arrived during its submission').toBeLessThanOrEqual(counted)
		expect(now, 'a count from this minute').toMatchObject({ n: shown, shown, fromEarlierWindow: false })
		expect(await windowRawCount(page, { now: Date.now() + 60_000 }), 'the same count a minute on')
			.toMatchObject({ n: 0, shown, fromEarlierWindow: true })

		// A pin still waiting for its click is cancelled by unpinReadouts, so the
		// next submission counts as usual.
		await pinReadout(page, 'pv-raw-n', shown + 50, { onNextSubmit: true })
		await unpinReadouts(page)
		await submitMood(page, 5)
		const next = Number(await page.getByTestId('pv-raw-n').textContent())
		expect(next, 'a cancelled pin never takes hold').toBe(shown + 1)

		// The poll judges against the baseline. Held at one above this window's
		// count, the card is the baseline, and the next publish only reaches it:
		// the submission must not count, although the card shows that frame's n.
		await pinReadout(page, 'pv-raw-n', next + 1)
		try {
			const refused = await submitMood(page, 1).then(() => null, (error) => error)
			expect(refused, 'a frame that does not raise the baseline must fail the poll').not.toBeNull()
			expect(refused.message).toContain(`the baseline was ${next + 1}\n`)
			expect(refused.message).toContain(`newest frame since the mark: n ${next + 1}\n`)
		} finally {
			await unpinReadouts(page)
		}
		// The defect this guards against, staged: the card shows the same n the
		// next publish brings, but the click is placed a minute on, so the
		// card's count is an earlier window's, the baseline is 0, and the
		// submission must count.
		await pinReadout(page, 'pv-raw-n', next + 2)
		try {
			await submitMood(page, 2, { now: Date.now() + 60_000 })
		} finally {
			await unpinReadouts(page)
		}
		const current = Number(await page.getByTestId('pv-raw-n').textContent())
		expect(current, 'both staged submissions were counted by the server').toBe(next + 2)

		// From the click on, the card holds two above what it showed. The next
		// publish carries one above, so the card and the newest frame disagree
		// and the submission must not count, although the readout is above the
		// baseline. The click is placed a minute on, so the card's count is an
		// earlier window's and the baseline is 0, not what the card shows.
		await pinReadout(page, 'pv-raw-n', current + 2, { onNextSubmit: true })
		try {
			const failure = await submitMood(page, 3, { now: Date.now() + 60_000 }).then(() => null, (error) => error)
			// The stage first, so a pin that never took hold is not read as the
			// helper passing a card it should have refused.
			expect(Number(await page.getByTestId('pv-raw-n').textContent()), 'the staged count must hold from the click on').toBe(current + 2)
			expect(failure, 'a card no frame matches must fail the poll').not.toBeNull()
			// Staged as intended: the pin took hold at the click, not before it.
			expect(failure.message).toContain(`card before the click: ${current}\n`)
			expect(failure.message).toContain(`card after the poll: ${current + 2}\n`)
			expect(failure.message).toContain(`newest frame since the mark: n ${current + 1}\n`)
			expect(failure.message, 'the baseline comes from the window, not the card')
				.toContain('the baseline was 0 (the card\'s n arrived before this minute was 2s old')
		} finally {
			await unpinReadouts(page)
		}
	})

	test('a submission waits out a countdown at 0 before taking its starting round', async ({ page }) => {
		// A round that has ended, as a page shows it until its next refresh,
		// staged: the previous round's id with its countdown at 0. Released
		// after 2 s, as a refresh would. Started from the stale id, the
		// submission would report the release as a crossing; it must start from
		// the round the page then names. One submission, no cohort assertion.
		// The wait for a fresh round can take most of a minute.
		test.setTimeout(120_000)
		await openPrivacy(page)
		await waitForFreshRound(page, { requireRoom: false })
		const fresh = await roundState(page)
		await pinRoundId(page, fresh.roundId - 1)
		await pinReadout(page, 'pv-round-reset', 0)
		try {
			setTimeout(() => {
				unpinRoundId(page).then(() => unpinReadouts(page)).catch(() => {})
			}, 2_000)
			expect(await submitMood(page, 3)).toEqual({ roundId: fresh.roundId, rolled: false })
		} finally {
			await unpinRoundId(page)
			await unpinReadouts(page)
		}
	})
})
