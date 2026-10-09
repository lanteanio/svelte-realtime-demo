import { expect, test } from '@playwright/test'
import { waitForWS, watchWire } from './helpers.js'
import { CLOSE_GRACE_MS, rawBaseline, rawCounted } from './raw-count.js'
import { formatDeliverySince, markDelivery, newestSince, valueArrivedAt } from './wire-report.js'

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
 *
 * Unbounded by default. `timeout` bounds each of the four reads for a caller
 * that must not wait on a page that has stopped showing the round.
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [options]
 */
export async function roundState(page, { timeout } = {}) {
	const read = timeout === undefined ? undefined : { timeout }
	const hint = page.getByTestId('pv-round-hint')
	return {
		roundId: Number(await hint.getAttribute('data-round-id', read)),
		distinct: Number(await page.getByTestId('pv-round-distinct').textContent(read)),
		k: Number(await page.getByTestId('pv-round-k').textContent(read)),
		resetInSeconds: Number(await page.getByTestId('pv-round-reset').textContent(read))
	}
}

/**
 * The bound on inStableRound's own re-reads of the round. On a live privacy
 * page the readout is always rendered and each read returns at once; the bound
 * only decides how long a page that can no longer show it is waited on.
 * Unbounded, that is the whole test timeout, and the test ends on a bare
 * timeout instead of on the step's own failure or on the guard's verdict
 * about the pass.
 */
const REREAD = { timeout: 10_000 }

/**
 * An error's message as the guard quotes it inside its own: without terminal
 * colour codes, and cut at the call log Playwright appends ("Call log:" on a
 * locator failure, "Call Log:" on a poll). Everything from there on is
 * dropped, including anything a caller appended after the call log, such as
 * submitMood's aggregate probe. What stays is the text above it: an expect
 * failure's matcher line with its Expected and Received values, or a locator
 * failure's own lines.
 * @param {unknown} err
 */
function failureText(err) {
	return String(/** @type {any} */ (err)?.message ?? err)
		.replace(/\x1b\[[0-9;]*m/g, '')
		.split(/\n\s*Call [Ll]og:/)[0]
		.trim()
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
 * handled rather than out-run. A retry must not run in a window the
 * abandoned attempt already contributed to: its identities would already be
 * counted there, and a sequence asserting that a submission adds a distinct
 * contributor would wait for a count that cannot rise. So for a caller that
 * asks for room (`requireRoom`, the default), the next attempt waits for a
 * round later than the latest one this guard saw the crossing reach. That
 * wait is the rest of the reached round and the start of the next one, up to
 * about 72 s after the crossing is seen, so with the abandoned attempt a
 * crossing costs such a caller about two rounds (RETRIED_SEQUENCE_TIMEOUT). A
 * caller that asks for no room counts no contributors and retries in the next
 * usable round, whichever it is.
 *
 * The guard covers the WHOLE body, not only the steps that detect a crossing
 * themselves. Only the helpers that read the round id throw RoundRolled; a
 * poll on a count, a cohort assertion, a snapshot comparison all fail with
 * ordinary errors when the tumble resets what they were reading. On any such
 * failure the round is re-read: moved means the boundary explains it and the
 * attempt is retried, unchanged means the failure is real and is rethrown
 * as-is. A genuine bug that coincides with a tumble costs one retry and then
 * fails again in a stable round, still loud.
 *
 * Success is checked too, by the same re-read: a pass that ends with the
 * page's round id different from the one it started with is treated as a
 * crossing and retried, never returned, because every count resets at the
 * tumble and the sequence's assertions may have come out right on readings
 * from both windows. Only the id is known to have moved, not that any
 * reading actually spanned it; a retry costs less than telling the two
 * apart. Every re-read, after a failure or a pass, reads `page` alone. A
 * sequence that also reads other pages gets no check on theirs, and a round
 * readout there can lag this page's by one refresh.
 *
 * `run` must leave `page` open and on /demos/privacy, because every re-read
 * reads the round from it, and so does the next attempt's wait for a fresh
 * round. The re-reads are bounded (REREAD), so a page that can no longer show
 * the round - closed, navigated away - is not waited on for the rest of the
 * test. After a failure, including a crossing the step detected itself, the
 * step's own error is rethrown unconverted; after a pass, the guard fails
 * saying the round could not be confirmed, since a pass it cannot place in
 * one window is not one it can return.
 *
 * A caller staging a crossing with pinRoundId keeps the pin in place until
 * the guard returns. A real round id never goes back, and releasing the pin
 * inside a retry would read as the round moving a second time. For a caller
 * that asks for room, the retry then waits for a round later than the staged
 * one, which a pinned page never shows: such a caller moves the pin past it
 * while the retry waits, as a real round would move, or the wait runs to its
 * timeout.
 *
 * @param {import('@playwright/test').Page} page
 * @param {(round: { roundId: number, distinct: number, k: number, resetInSeconds: number }, attempt: number) => Promise<any>} run
 */
export async function inStableRound(page, run, { attempts = 2, freshRound } = {}) {
	let rolled
	// The latest round id seen once a crossing was detected; with room asked
	// for, the next attempt waits for a round past it.
	let reached = null
	const countsContributors = freshRound?.requireRoom !== false
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const round = await waitForFreshRound(page, reached !== null && countsContributors ? { ...freshRound, after: reached } : freshRound)
		let result
		try {
			result = await run(round, attempt)
		} catch (err) {
			if (err instanceof RoundRolled) {
				// Recorded before anything else, so a crossing that ends the
				// guard on the re-read below is on the report as well.
				rolled = err
				noteRoll(`attempt ${attempt} of ${attempts}: ${err.message}`)
				// The next attempt starts by waiting on this page for a fresh
				// round, unbounded: on a page that navigated away it never
				// returns, and on a closed one it fails with a Playwright error
				// in place of the crossing. A page that cannot answer a bounded
				// read ends here with the crossing instead. On the last attempt
				// nothing follows, and the crossing is thrown below either way.
				if (attempt < attempts) {
					let current
					try {
						current = await roundState(page, REREAD)
					} catch {
						throw err
					}
					reached = Math.max(err.to, current.roundId)
				}
				continue
			}
			// A failure that is not a detected crossing may still be the
			// boundary presenting through whichever step was running: every
			// round-scoped number resets at the tumble, so a poll that timed
			// out or a count that read wrong WHILE the round moved is
			// explained by the boundary, and only the steps that read the
			// round id ever throw RoundRolled themselves. If the round is
			// unchanged the failure is real and stays loud. A page that cannot
			// answer the bounded read rethrows the original failure rather
			// than an error about the check.
			let current
			try {
				current = await roundState(page, REREAD)
			} catch {
				throw err
			}
			if (current.roundId === round.roundId) throw err
			reached = current.roundId
			rolled = new RoundRolled(
				round.roundId,
				current.roundId,
				`running a round-scoped step whose failure the boundary explains: ${failureText(err)}`
			)
			noteRoll(`attempt ${attempt} of ${attempts}: ${rolled.message}`)
			continue
		}
		let settled
		try {
			settled = await roundState(page, REREAD)
		} catch (readError) {
			throw new Error(
				'a round-scoped sequence passed, but the round could not be re-read to confirm it ran in one window: ' +
				failureText(readError)
			)
		}
		if (settled.roundId === round.roundId) return result
		reached = settled.roundId
		rolled = new RoundRolled(round.roundId, settled.roundId, 'a round-scoped sequence ran to a pass, so its readings may mix both windows')
		noteRoll(`attempt ${attempt} of ${attempts}: ${rolled.message}`)
	}
	throw rolled
}

/**
 * The test timeout for a sequence run in inStableRound with room asked for,
 * sized for its retry.
 *
 * The page's countdown reads anywhere from just under a second below the time
 * actually left to just under two above it: the server rounds the time left
 * up, and the page ticks it down on a phase of its own. So the default
 * fresh-round wait accepts a reading taken between about 2 and 12 s into a
 * round. Each leg can then take most of a round:
 *
 * - the first wait for a fresh round: up to about 56 s, from just after one
 *   round's last qualifying reading to the next round's first, which the page
 *   shows at its next 5 s refresh;
 * - an attempt slow enough to cross its boundary, and the wait for a round
 *   later than the one it crossed into: up to about 130 s together, from about
 *   2 s into the attempt's round to about 12 s into the round after the next;
 * - the second attempt: about a minute. One that crosses as well fails the
 *   test either way.
 *
 * That is about 246 s. The rest covers the test's own setup on a slow host.
 */
export const RETRIED_SEQUENCE_TIMEOUT = 300_000

/**
 * Wait for a round that has room for this test's contributor, has enough
 * time left for the test to finish inside it, and has already been running
 * for a few seconds.
 *
 * Room and time are separate requirements.
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
 * really just a new window. So this waits for a round with real headroom, and
 * callers can assume one window for their whole sequence and keep asserting
 * monotonic counts.
 *
 * The default demands a round that has only JUST tumbled rather than merely
 * one with some time left. A five-submission sequence costs around 25 seconds
 * because each submission waits for an aggregate publish, so "20 seconds
 * remaining" still straddles; the only reliable window is a fresh one. Both
 * conditions come true together at every tumble - distinct resets to 0 as the
 * clock resets to 60 - and the page shows a new round at its next 5 s refresh,
 * so the wait is bounded by about one round plus that refresh. The refresh is
 * also why the default is 50 rather than 60.
 *
 * Fresh does not mean the first moments of a round, though (`minSecondsIn`).
 * roundInfo() names the round from the wall clock as soon as the minute
 * turns, while the aggregates close their windows on a server timer that can
 * fire after that instant, and can fire twice. A submission made in those
 * moments can be counted in a window other than the one the page names. The
 * countdown is sampled on the server and then ticked down on the page on a
 * phase of its own, so a reading can show up to a second less time left than
 * there is: a reading of 57 means more than two seconds of the round have
 * passed. `minSecondsLeft` and `minSecondsIn` together may not exceed 60, or
 * no reading would qualify.
 *
 * `after`, when given, also asks for a round id later than it: inStableRound
 * passes the latest round a crossing reached, so a retry does not run in a
 * window its abandoned attempt contributed to.
 */
export async function waitForFreshRound(page, { timeout = 90_000, minSecondsLeft = 50, minSecondsIn = 3, requireRoom = true, after } = {}) {
	if (minSecondsLeft + minSecondsIn > 60) {
		throw new Error(`waitForFreshRound: minSecondsLeft (${minSecondsLeft}) + minSecondsIn (${minSecondsIn}) exceeds the 60 s round`)
	}
	// `requireRoom` is for callers that do not add a contributor and do not
	// assert anything about the cohort. Making them wait out a tumble for room
	// they never use costs a minute and, worse, forces them to run at the one
	// moment the round is about to turn over.
	const usable = (s) =>
		(!requireRoom || s.distinct < s.k - 1) &&
		s.resetInSeconds >= minSecondsLeft &&
		60 - s.resetInSeconds >= minSecondsIn &&
		(after === undefined || s.roundId > after)
	const state = await roundState(page)
	if (usable(state)) return state
	await expect.poll(async () => usable(await roundState(page)), {
		timeout,
		intervals: [1_000],
		message: `no round${after === undefined ? '' : ` later than ${after}`} with ${requireRoom ? 'room for a contributor, ' : ''}at least ${minSecondsLeft}s left and ${minSecondsIn}s in`
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

/**
 * The raw count of the window a submission made now lands in: rawBaseline
 * (raw-count.js) over the raw readout's n and the time its value arrived, by
 * the wire record. `n` equals the readout's n when that value arrived at least
 * CLOSE_GRACE_MS into the minute `now` falls in, and 0 otherwise, since a page
 * that lived through a tumble keeps showing the closing window's count. The
 * minute is taken from this process's clock and the server names windows from
 * its own, so this relies on the two agreeing to well under CLOSE_GRACE_MS, as
 * on one host.
 * A closing publish later than the grace is taken as the current window's, and
 * the arrival time is when this process received the frame, so a busy test
 * process can also push a closing publish past the grace.
 *
 * `now` picks the minute (default: this process's clock now). Needs a page
 * opened with openPrivacy, whose wire record saw the raw stream's subscribe.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ now?: number }} [options]
 */
export async function windowRawCount(page, { now = Date.now() } = {}) {
	const wire = watchWire(page)
	const topic = markDelivery(wire, 'rawMood').topic
	if (topic === null) {
		throw new Error('the wire record holds no answered rawMood stream, so the raw count cannot be placed in a window')
	}
	// The arrival time is taken before the readout is read: a frame landing
	// between the two then pairs an older time with a newer count, which can
	// only lower the result, never leave it at an earlier window's count. Not
	// covered: the page applies stream frames on its next animation frame, so
	// a frame recorded just before this read can pair a newer time with the
	// older count still showing.
	const windowStart = Math.floor(now / 60_000) * 60_000
	const arrived = valueArrivedAt(wire, topic)
	const shown = (await rawState(page)).n
	const arrivedAt = arrived === null ? null : wire.armedAt + arrived
	const { before, fromEarlierWindow } = rawBaseline({ shown, arrivedAt, windowStart })
	return { n: before, shown, arrivedAt, fromEarlierWindow }
}

export async function protectedSnapshot(page) {
	return (await page.getByTestId('pv-protected-value-area').innerText()).replace(/\s+/g, ' ').trim()
}

/**
 * Submit one mood and confirm the raw aggregate counted it.
 *
 * Counted means: the newest raw frame delivered since the mark, which is taken
 * just before the click, carries an n above the baseline, and the card shows
 * that frame's n. The frame is read off the wire (watchWire), so a card that
 * already showed a high enough number cannot pass on its own. The card must
 * show the frame's n, so a page that never applies the frame passes only when
 * its card already showed that same n.
 *
 * The baseline is windowRawCount's: the count of the window this click lands
 * in, which the card cannot always say. A page that lived through a tumble
 * keeps showing the closing window's final count until the new window first
 * publishes, and the new window's first submission then publishes an n of 1,
 * which a baseline of that old count would refuse.
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
 * The starting round is read only once the countdown is above 0. The server
 * never reports 0, so a 0 is the page's own tick running past the last
 * reading: the round has ended or is in its last second, and the page shows
 * it until its next 5 s refresh. Starting from that round's id would report
 * the refresh as a crossing although the whole submission ran in the next
 * round.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} score
 * @param {{ onRoll?: 'throw' | 'skip', now?: number }} [options] `now` is
 * passed to windowRawCount, to place the click in a different minute.
 */
export async function submitMood(page, score, { onRoll = 'throw', now } = {}) {
	await expect.poll(async () => (await roundState(page)).resetInSeconds, {
		timeout: 10_000,
		message: 'the round countdown stayed at 0, so the page never showed the round this submission lands in'
	}).toBeGreaterThan(0)
	const startRoundId = (await roundState(page)).roundId
	const wire = watchWire(page)
	const { n: before, shown, arrivedAt, fromEarlierWindow } = await windowRawCount(page, { now })
	// Marked BEFORE the click. The publish this waits for is the one the click
	// causes, and the record counts deliveries cumulatively, so a count read
	// afterwards cannot be separated from what had already arrived.
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
		const delivered = newestSince(wire, mark)?.data?.n
		return rawCounted({ before, delivered, shown: (await rawState(page)).n })
	}
	try {
		await expect.poll(counted, {
			timeout: 10_000,
			message:
				`the raw aggregate never counted the ${score}/5 submission within 10s inside round ${startRoundId}, ` +
				`with no round boundary to explain it; the baseline was ${before}` +
				(arrivedAt === null
					? ' (the wire record cannot say when the card\'s n arrived)'
					: fromEarlierWindow
						? ` (the card's n arrived before this minute was ${CLOSE_GRACE_MS / 1000}s old, so it was taken as an earlier window's)`
						: '')
		}).toBe(true)
	} catch (error) {
		// The note asserted above renders only after the RPC resolves, so the
		// submission is already proven accepted by the time this fails. What is
		// left is what the page showed against what arrived, and whether the
		// aggregate published at all, which no number on the page can answer
		// and the wire can.
		const after = await page.getByTestId('pv-raw-n').textContent({ timeout: 1_000 }).catch(() => page.getByTestId('pv-raw-empty').count()
			.then((empty) => (empty ? 'empty' : 'not on the page'), () => 'unreadable'))
		const newest = newestSince(wire, mark)?.data?.n
		error.message = `${error.message}

--- raw counts ---
card before the click: ${shown}
card after the poll: ${after}
newest frame since the mark: ${newest === undefined ? 'none' : `n ${newest}`}

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
		// Calling it again moves the pin rather than adding a second one.
		clearInterval(window.__pvPinnedRound)
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
 * Held with pinReadout, whose observer puts the count back before the page
 * yields, so no read can land between the page applying a frame and the pin
 * undoing it. A pin re-applied on a timer leaves that gap open, and a poll that
 * reads inside it sees the applied count and passes. Needs the card to show a
 * count, and to keep showing one: the readout is one text node, which an empty
 * card does not have, and a card that empties and fills again renders a new
 * node the pin does not hold.
 *
 * @returns the value the readout is held at, which the failure message quotes
 */
export async function pinRawCount(page) {
	const frozen = await page.getByTestId('pv-raw-n').textContent({ timeout: 5_000 })
	await pinReadout(page, 'pv-raw-n', frozen)
	return frozen
}

/** Release the freeze (and any other pinned readout) and show the page's count again. */
export async function unpinRawCount(page) {
	await unpinReadouts(page)
}

/**
 * Hold a round readout (pv-round-reset, pv-round-distinct, ...) at a chosen
 * text.
 *
 * Each readout is one text node the page rewrites when its value changes.
 * Every rewrite is recorded and put back by a MutationObserver, whose callback
 * runs before the page yields to any other task, so a read from the test
 * cannot land between the page's value and the pinned one. The observer's own
 * writes are taken off its queue as they are made, so what it records is only
 * what the page wrote. Calling it again for the same readout moves the pin.
 *
 * With `onNextSubmit`, the pin is placed when the next mood button is clicked
 * (in the capture phase, before the app's own handler runs) rather than now,
 * so a reading taken before that click still sees the page's own text.
 *
 * @returns the text the pin holds as the page's own when it is placed: the
 * text showing for a first pin, the last text it recorded for a moved one. It
 * is taken in the same step as the pin, so no page write can fall between.
 * Null with `onNextSubmit`, as the pin is not placed yet.
 */
export async function pinReadout(page, testId, value, { onNextSubmit = false } = {}) {
	return page.evaluate(([id, pinned, deferred]) => {
		const place = () => {
			const text = document.querySelector(`[data-testid="${id}"]`)?.firstChild
			if (!(text instanceof Text)) throw new Error(`${id} holds no text node to pin`)
			const pins = (window.__pvPins ??= {})
			const pin = (pins[id] ??= { text, real: text.nodeValue })
			const found = pin.real
			pin.observer?.disconnect()
			const observer = new MutationObserver(() => {
				pin.real = text.nodeValue
				apply()
			})
			const apply = () => {
				text.nodeValue = pinned
				observer.takeRecords()
			}
			observer.observe(text, { characterData: true })
			apply()
			pin.observer = observer
			return found
		}
		if (!deferred) return place()
		const pending = (window.__pvPendingPins ??= new Set())
		const onClick = (event) => {
			if (!event.target.closest('button[data-testid^="pv-submit-"]')) return
			document.removeEventListener('click', onClick, true)
			pending.delete(onClick)
			place()
		}
		pending.add(onClick)
		document.addEventListener('click', onClick, true)
		return null
	}, [testId, String(value), onNextSubmit])
}

/**
 * Release every pinned readout and put back the text the page last wrote to
 * it, which is what the page's own renderer expects to find there. A pin
 * waiting for its click (onNextSubmit) is cancelled.
 */
export async function unpinReadouts(page) {
	await page.evaluate(() => {
		for (const onClick of window.__pvPendingPins ?? []) document.removeEventListener('click', onClick, true)
		delete window.__pvPendingPins
		for (const pin of Object.values(window.__pvPins ?? {})) {
			pin.observer.disconnect()
			pin.text.nodeValue = pin.real
		}
		delete window.__pvPins
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
