import { expect, test } from '@playwright/test'
import { waitForWS, watchWire } from './helpers.js'
import { formatDeliverySince, markDelivery } from './wire-report.js'

/**
 * Thrown when a round boundary crossed a sequence that can only be asserted
 * inside one round.
 *
 * Every number this demo publishes is scoped to a tumbling minute, so a
 * reading taken before the boundary and a reading taken after it describe
 * different windows. The counts restart at zero, which presents as a count
 * that went backwards - `n` reading 1 where 5 was expected looks exactly
 * like four lost submissions. Distinguishing the two is not possible from
 * the numbers alone, so the boundary is raised as its own condition rather
 * than left to surface as a bare `Expected: > 1  Received: 1`.
 *
 * This is a control-flow signal, not a defect: callers wrapped in
 * `inStableRound` retry in the next window.
 */
export class RoundRolled extends Error {
	/** @param {number} from @param {number} to @param {string} during */
	constructor(from, to, during) {
		super(
			`the privacy round rolled from ${from} to ${to} while ${during}. ` +
			'Every count on this page is scoped to a tumbling minute, so readings ' +
			'either side of the boundary are not comparable; the counts restarted ' +
			'rather than regressed.'
		)
		this.name = 'RoundRolled'
		this.from = from
		this.to = to
	}
}

/** Record a boundary crossing on the test report without failing the run. */
function noteRoll(description) {
	test.info().annotations.push({ type: 'round-rolled', description })
}

export async function openPrivacy(page, url = '/demos/privacy') {
	// Before the navigation: the wire record only sees sockets opened after it
	// exists, and what it is here to answer - whether the aggregate published -
	// is a question about frames that arrive seconds later.
	watchWire(page)
	await page.goto(url)
	await waitForWS(page)
	await expect(page.getByTestId('pv-round-hint')).toBeVisible({ timeout: 10_000 })
}

/**
 * Read the round hint.
 *
 * `roundId` is the tumbling window index the aggregates use, published by
 * the demo-only `roundInfo()` endpoint. It is what makes every other number
 * here comparable: two readings mean something together only when they
 * carry the same id.
 */
export async function roundState(page) {
	const hint = page.getByTestId('pv-round-hint')
	return {
		roundId: Number(await hint.getAttribute('data-round-id')),
		distinct: Number(await page.getByTestId('pv-round-distinct').textContent()),
		k: Number(await page.getByTestId('pv-round-k').textContent()),
		resetInSeconds: Number(await page.getByTestId('pv-round-reset').textContent())
	}
}

/**
 * Fail with the boundary named if the round moved under a sequence.
 *
 * A caller asserting across several submissions holds the boundary open for
 * its whole span, not just inside one helper's poll: a tumble arriving
 * between two submissions leaves every per-submission check green and only
 * breaks the totals at the end.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} startRoundId
 * @param {string} during
 */
export async function assertSameRound(page, startRoundId, during) {
	const { roundId } = await roundState(page)
	if (roundId !== startRoundId) throw new RoundRolled(startRoundId, roundId, during)
}

/**
 * Run a sequence that is only meaningful inside a single round, retrying in
 * the next window if the boundary crosses it.
 *
 * The alternative - widening `minSecondsLeft` until a tumble becomes
 * unlikely - only moves the odds. A minute is a hard ceiling on how much
 * work fits in one window, and a sequence that waits for an aggregate
 * publish per step has no guaranteed cost, so the boundary case has to be
 * handled rather than out-run. Retrying is safe because the submissions the
 * abandoned attempt already made carry the same identity: they add to the
 * new window's event count, which the caller re-baselines, and they cannot
 * add a second distinct contributor.
 *
 * @param {import('@playwright/test').Page} page
 * @param {(round: { roundId: number, distinct: number, k: number, resetInSeconds: number }, attempt: number) => Promise<any>} run
 */
export async function inStableRound(page, run, { attempts = 2, freshRound } = {}) {
	let rolled
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const round = await waitForFreshRound(page, freshRound)
		try {
			return await run(round, attempt)
		} catch (err) {
			if (!(err instanceof RoundRolled)) throw err
			rolled = err
			noteRoll(`attempt ${attempt} of ${attempts}: ${err.message}`)
		}
	}
	throw rolled
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
export async function waitForFreshRound(page, { timeout = 90_000, minSecondsLeft = 50, requireRoom = true } = {}) {
	// `requireRoom` is for callers that do not add a contributor and do not
	// assert anything about the cohort. Making them wait out a tumble for room
	// they never use costs a minute and, worse, forces them to run at the one
	// moment the round is about to turn over.
	const usable = (s) => (!requireRoom || s.distinct < s.k - 1) && s.resetInSeconds >= minSecondsLeft
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

/**
 * Submit one mood and confirm the raw aggregate counted it.
 *
 * The raw count is round-scoped, so "it went up" is only evidence inside
 * one window. When the round tumbles while this is waiting, the count
 * restarts and the submission is genuinely uncountable from here: the raw
 * card also keeps serving the previous window's value until the new
 * window's first publish lands, so neither the old number nor the new one
 * proves anything about this click. Rather than accept whatever the card
 * happens to show - which passes without ever testing anything - the
 * boundary is reported.
 *
 * `onRoll` picks who handles it. 'throw' (the default) hands it to an
 * `inStableRound` wrapper, which retries the whole sequence in the next
 * window and keeps the count assertion strong. 'skip' is for callers whose
 * subject is the round-scoped distinct count rather than the running event
 * total; they lose nothing across a tumble, and the crossing is recorded as
 * a test annotation so a run that took the weaker path still says so.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} score
 * @param {{ onRoll?: 'throw' | 'skip' }} [options]
 */
export async function submitMood(page, score, { onRoll = 'throw' } = {}) {
	const startRoundId = (await roundState(page)).roundId
	const before = (await rawState(page)).n
	// Marked BEFORE the click. The publish this waits for is the one the click
	// causes, and the record counts deliveries cumulatively, so a count read
	// afterwards cannot be separated from what had already arrived.
	const wire = watchWire(page)
	const mark = markDelivery(wire, 'rawMood')
	await page.getByTestId(`pv-submit-${score}`).click()
	await expect(page.getByTestId('pv-submit-note')).toContainText(`Submitted ${score}/5`)
	await expect(page.getByTestId(`pv-submit-${score}`)).toHaveClass(/btn-primary/)

	// The round is read FIRST each time: once the boundary has passed, the
	// count read after it belongs to a different window and cannot be
	// compared to `before` at all, so its value must not decide the poll.
	let rolledTo = null
	const counted = async () => {
		const { roundId } = await roundState(page)
		if (roundId !== startRoundId) {
			rolledTo = roundId
			return true
		}
		return (await rawState(page)).n > before
	}
	try {
		await expect.poll(counted, {
			timeout: 10_000,
			message:
				`the raw aggregate never counted the ${score}/5 submission: n stayed at ${before} ` +
				`for 10s inside round ${startRoundId}, with no round boundary to explain it`
		}).toBe(true)
	} catch (error) {
		// The note asserted above renders only after the RPC resolves, so the
		// submission is already proven accepted by the time this fails. What is
		// left is whether the aggregate published at all, which no number on the
		// page can answer and the wire can.
		error.message = `${error.message}

--- aggregate probe ---
${formatDeliverySince(wire, mark)}`
		throw error
	}

	if (rolledTo === null) return { roundId: startRoundId, rolled: false }
	const rolled = new RoundRolled(startRoundId, rolledTo, `waiting for the raw aggregate to count a ${score}/5 submission`)
	if (onRoll === 'throw') throw rolled
	noteRoll(rolled.message)
	return { roundId: rolledTo, rolled: true }
}

/**
 * How far a staged round id sits from the real one.
 *
 * Deliberately far larger than one. A staged crossing races the page's own
 * 5-second refresh: unpinning leaves the stale value in the DOM until that
 * refresh rewrites it, so a stage computed as "whatever is showing, plus
 * one" can land on the exact id the code under test already read, and then
 * there is no crossing to detect and the test passes having proved nothing.
 * A thousand minutes is far enough ahead that no real tumble during a run
 * can coincide with it, which makes the crossing unconditional.
 */
export const STAGED_ROUND_STEP = 1_000

/**
 * Hold the page's round id at a chosen value.
 *
 * A real boundary arrives at most once a minute and never on demand, so the
 * only way to exercise the crossing path on every run is to stage the
 * crossing where it actually presents: the attribute the helpers read. The
 * detection code under test is the real one, reading the real DOM.
 *
 * Re-applied on an interval because the page overwrites the attribute from
 * `roundInfo()` every 5 seconds, which would otherwise retire the staged
 * crossing mid-assertion.
 */
export async function pinRoundId(page, roundId) {
	await page.evaluate((id) => {
		const hint = () => document.querySelector('[data-testid="pv-round-hint"]')
		// Remember the page's own value: the attribute is only ever rewritten
		// by the framework when the id CHANGES, so an overwritten one is not
		// restored by the next poll and has to be put back by hand.
		if (window.__pvRealRound === undefined) window.__pvRealRound = hint()?.getAttribute('data-round-id')
		const apply = () => {
			const el = hint()
			if (el) el.setAttribute('data-round-id', String(id))
		}
		apply()
		window.__pvPinnedRound = setInterval(apply, 50)
	}, roundId)
}

/**
 * Stage a crossing that lands DURING the next submission rather than before
 * it.
 *
 * Ordering is the whole difficulty: `submitMood` reads the round before it
 * clicks, so an id pinned up front is simply the round it starts in and no
 * crossing is ever observed. Hanging the pin off the click - in the capture
 * phase, so it is armed before the app's own handler runs - puts the change
 * exactly where the real race puts it: after the starting read, while the
 * raw count is being waited on.
 *
 * The staged id is fixed when the stage is armed and applied the instant the
 * click lands. Deriving it at click time, or letting the first application
 * wait for a timer, both leave a window in which the count can settle first
 * and the crossing is never seen.
 */
export async function stageRollOnNextSubmit(page) {
	await page.evaluate((step) => {
		const hint = () => document.querySelector('[data-testid="pv-round-hint"]')
		if (window.__pvRealRound === undefined) window.__pvRealRound = hint()?.getAttribute('data-round-id')
		const next = String(Number(hint().getAttribute('data-round-id')) + step)
		const onClick = (event) => {
			if (!event.target.closest('[data-testid^="pv-submit-"]')) return
			document.removeEventListener('click', onClick, true)
			const apply = () => {
				const el = hint()
				if (el) el.setAttribute('data-round-id', next)
			}
			apply()
			window.__pvPinnedRound = setInterval(apply, 25)
		}
		document.addEventListener('click', onClick, true)
	}, STAGED_ROUND_STEP)
}

/**
 * Release a staged crossing and put the page's own value back.
 *
 * The value is restored explicitly rather than waited for. The framework
 * writes this attribute only when the id changes, so an id overwritten here
 * survives every subsequent poll that reports the same round - waiting for
 * the page to correct it would wait out the rest of the round.
 */
export async function unpinRoundId(page) {
	await page.evaluate(() => {
		clearInterval(window.__pvPinnedRound)
		delete window.__pvPinnedRound
		const el = document.querySelector('[data-testid="pv-round-hint"]')
		if (el && window.__pvRealRound != null) el.setAttribute('data-round-id', window.__pvRealRound)
		delete window.__pvRealRound
	})
}

/**
 * Freeze the raw count the submission poll reads, leaving the socket alone.
 *
 * This stages the ONE fault the count on its own cannot distinguish from a
 * publish that never happened: the aggregate publishes, the frames arrive, and
 * the page does not apply them. Staged in the DOM rather than by intercepting
 * the socket on purpose - a routed socket is the arrangement the delivery
 * report refuses to speak for, so intercepting to produce the failure would
 * make the very verdict under test unreachable.
 *
 * Re-applied on an interval for the same reason the round pin is: the page
 * rewrites the node whenever the aggregate changes, which is exactly what is
 * being suppressed.
 *
 * @returns the value the readout is held at, which the failure message quotes
 */
export async function pinRawCount(page) {
	return page.evaluate(() => {
		const node = () => document.querySelector('[data-testid="pv-raw-n"]')
		const frozen = node()?.textContent ?? '0'
		const apply = () => {
			const el = node()
			if (el && el.textContent !== frozen) el.textContent = frozen
		}
		apply()
		window.__pvPinnedRaw = setInterval(apply, 25)
		return frozen
	})
}

/** Release the freeze and let the page show the aggregate again. */
export async function unpinRawCount(page) {
	await page.evaluate(() => {
		clearInterval(window.__pvPinnedRaw)
		delete window.__pvPinnedRaw
	})
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
