import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'
import {
	RESTORE, NAV, setSpeed, setRawSpeed, setBias, expectHydrated, rows, total,
	leaderShare, populated, dominant, spread, describeShare,
	hotSignal, hotLed, describeHot, restoreTopkDefaults
} from './topk-helpers.js'

// Exhaustive human-like coverage for /demos/topk - four leaderboards from
// ONE event firehose, declared in one live.aggregate({ windows }) block:
// last10s (sliding 10s/1s hops), last1min (sliding 60s/5s hops), thisMinute
// (tumbling per-minute), lifetime (no minute-boundary reset). Drives every interactive
// element (the speed slider and all three bias buttons) and asserts REAL window
// semantics: all four windows populate with a correctly ORDERED top-5 capped
// at 5 of the 12-item pool; the controls hydrate from the server across a
// reload; BOTH sliding windows decay to empty on their own clocks when the
// firehose stops, each held inside its own two-sided bracket measured from the
// pause - last10s to (5s, 21s), last1min to (40s, 80s) of drain - and lifetime
// keeps publishing once it restarts; the tumbling window RESETS on the
// wall-clock boundary while lifetime keeps climbing and does not reset at
// THAT boundary - which is where that property is pinned, NOT in the decay test (see the
// comment there); each bias button re-shapes the
// distribution (monopoly -> one item dominates, hot -> the three hot items
// take the top three, uniform -> the spread comes back) and marks the active
// control. The slider's magnitude is pinned by equal-duration lifetime-growth
// samples at 5 and 25 events/sec; its zero label and the server's upper clamp
// are pinned separately. Rendered rows also pin their one-based rank and bar
// width. Cross-replica behaviour lives in the .cluster.spec.js sibling.
//
// Speed + bias are GLOBAL cluster-shared Redis keys, so every test that
// changes them restores the defaults in a finally, and an afterEach re-runs
// the restore from a fresh context. The afterEach is not redundant: on a
// TIMEOUT the finally does still run (the pending await rejects), but it runs
// against a page the runner has already torn down, so its restores fail.
// (workers=1 serial; per-tier FLUSHDB gives a clean start at speed=5 /
// uniform.)

// `opts` is passed through to goto. Only the teardown path uses it: neither
// this config nor Playwright's defaults bound a navigation (no navigationTimeout
// is set), so an unbounded goto in the afterEach would blow the hook's slot no
// matter what wall-clock deadline the loop carries. Test bodies keep the
// unbounded default deliberately - a cold dev-server navigation is slow but not
// a defect, and bounding it there would trade a real signal for a flake.
async function open(page, opts) {
	await page.goto('/demos/topk', opts)
	await waitForWS(page)
}

// Bounded restore: never throws, never hangs. Every teardown path uses this.
async function restoreDefaults(page) {
	await setBias(page, 'uniform', RESTORE).catch(() => {})
	await setSpeed(page, 5, RESTORE).catch(() => {})
}

test.describe('/demos/topk', () => {
	// Backstop for the shared speed/bias keys. Each test restores them in its
	// own finally, but on a TIMEOUT that finally runs against a page the runner
	// has already torn down, so its restores fail - and both keys are global,
	// so a leak lands on whatever runs next (speed 0 leaking into the tumbling
	// test starves it). Best-effort: teardown never fails a test.
	// Structurally mirrors the afterEach in demos-flags.cluster.spec.js, with
	// the flush + readback loop added on top - that sibling has neither.
	test.afterEach(async ({ browser, baseURL }) => {
		const restored = await restoreTopkDefaults(browser, { baseURL, open })
		// Exhausting the loop silently is how the NEXT test ends up failing for
		// a reason that has nothing to do with its own subject. Still not a
		// failure (teardown must not fail a test), but it must not be invisible.
		if (!restored) console.warn('[topk afterEach] speed/bias NOT restored - the next test may inherit them')
	})

	test('renders all four leaderboards, the speed slider, and the bias controls', async ({ page }) => {
		// Worst case: 15s WS + eight sequential 10s visibility waits. (The
		// afterEach runs on its own timeout slot, so it is not counted here.)
		test.setTimeout(120_000)
		await open(page)
		await expect(page.getByTestId('lb-last10s')).toBeVisible()
		await expect(page.getByTestId('lb-last1min')).toBeVisible()
		await expect(page.getByTestId('lb-thisMinute')).toBeVisible()
		await expect(page.getByTestId('lb-lifetime')).toBeVisible()
		await expect(page.getByTestId('speed-input')).toBeVisible()
		await expect(page.getByTestId('bias-uniform')).toBeVisible()
		await expect(page.getByTestId('bias-hot')).toBeVisible()
		await expect(page.getByTestId('bias-monopoly')).toBeVisible()
	})

	test('leaderboard names retain readable width through tablet and fixed-sidebar breakpoints', async ({ page }) => {
		test.setTimeout(90_000)
		await page.setViewportSize({ width: 640, height: 900 })
		await open(page)
		await expectHydrated(page)

		for (const width of [640, 768, 1024]) {
			await page.setViewportSize({ width, height: 900 })
			for (const panel of ['lb-last10s', 'lb-last1min', 'lb-thisMinute', 'lb-lifetime']) {
				const geometry = await page.getByTestId(`${panel}-row`).first().evaluate((row) => {
					const name = row.querySelector('[data-testid$="-name"]')
					const bar = row.querySelector('[data-testid$="-bar"]')
					const rowBox = row.getBoundingClientRect()
					const nameBox = name?.getBoundingClientRect()
					const barBox = bar?.getBoundingClientRect()
					return {
						name: name?.textContent?.trim() ?? '',
						nameWidth: nameBox?.width ?? 0,
						barWidth: barBox?.width ?? 0,
						insideRow: Boolean(nameBox && barBox && nameBox.left >= rowBox.left && barBox.right <= rowBox.right + 0.5)
					}
				})
				expect(geometry.name, `${panel} name at ${width}px`).not.toBe('')
				expect(geometry.nameWidth, `${panel} name width at ${width}px`).toBeGreaterThanOrEqual(96)
				expect(geometry.barWidth, `${panel} bar remains sacrificial at ${width}px`).toBeLessThanOrEqual(64)
				expect(geometry.insideRow, `${panel} row containment at ${width}px`).toBe(true)
			}
		}
	})

	test('the controls hydrate from the server: a changed speed and bias survive a reload', async ({ page }) => {
		// Worst case: 15s WS + 20s hydration gate + 20s bounded pre-state reads
		// + 30s delivery gate + 15s WS after reload + five sequential 10s
		// readback assertions + 10s of bounded restores = 160s, plus two
		// navigations against a dev server. The 210s slot leaves 50s for those
		// navigations rather than calling their significant cost free.
		test.setTimeout(210_000)
		await open(page)
		try {
			// The delivery gate below matches on item NAMES, so it carries the
			// same exposure the hot and monopoly tests do - see expectHydrated.
			await expectHydrated(page)
			// Choose BOTH targets from the observed hydrated pre-state. Fixed
			// speed=25 / bias=hot targets are not discriminating after an
			// interrupted prior run leaks those exact Redis values: dead
			// setSpeed/setBias calls would inherit the target, satisfy the data
			// gate immediately, and pass every reload assertion. A target that
			// differs from what this page actually observed forces a transition
			// in every starting state.
			const beforeSpeed = await page.getByTestId('speed-input').inputValue({ timeout: 10_000 })
			const biasIds = ['uniform', 'hot', 'monopoly']
			const biasClasses = await Promise.all(biasIds.map((id) =>
				page.getByTestId(`bias-${id}`).getAttribute('class', { timeout: 10_000 })))
			const beforeBias = biasIds.find((_, i) => biasClasses[i]?.includes('btn-primary'))
			expect(beforeBias).toBeTruthy()
			const targetSpeed = beforeSpeed === '25' ? 31 : 25
			const targetBias = beforeBias === 'hot' ? 'monopoly' : 'hot'
			await setSpeed(page, targetSpeed)
			await setBias(page, targetBias)

			// Both control writes are RPCs on the same socket; fill/click resolve
			// before the frames flush, and a reload that tears the socket first
			// loses them (flake, not false pass). Waiting for a server-side
			// consequence of the bias write before reloading removes that
			// exposure for the write it can see. The target is dynamic, so use
			// the same magnitude-bearing signal as the owning hot/monopoly test.
			//
			// This gates the BIAS write ONLY. Either distribution signal is
			// reachable at the default speed 5, so it is not evidence that the
			// speed write landed. A lost speed write surfaces as a failure of the
			// slider readback below, which is red rather than a false pass.
			await expect.poll(async () => {
				if (targetBias === 'hot') {
					const s = await hotSignal(page, 'lb-last10s')
					return hotLed(s) ? 'target' : describeHot(s)
				}
				const s = await leaderShare(page, 'lb-last10s')
				return dominant(s) ? 'target' : describeShare(s)
			}, { timeout: 30_000 }).toBe('target')

			await page.reload()
			await waitForWS(page)

			// These can only read back this way if myTopkState() hydrated them.
			await expect(page.getByTestId('speed-input')).toHaveValue(String(targetSpeed), { timeout: 10_000 })
			await expect(page.getByTestId(`bias-${targetBias}`)).toHaveClass(/btn-primary/, { timeout: 10_000 })
			for (const id of biasIds.filter((id) => id !== targetBias)) {
				await expect(page.getByTestId(`bias-${id}`)).not.toHaveClass(/btn-primary/)
			}
			// The slider label is rendered from the same hydrated state, so it
			// has to agree with the input's value rather than the initializer's 5.
			await expect(page.getByText(`Firehose (${targetSpeed} events/sec)`)).toBeVisible()
		} finally {
			// Best-effort AND bounded - see restoreDefaults. A bias click that
			// fails on a LIVE page must not also skip the speed restore, and
			// neither a throw nor a hang here may replace the body's real
			// assertion error, which is how a failing run ends up unreadable. (A
			// torn-down page fails both; the afterEach is the guaranteed restore
			// either way.)
			await restoreDefaults(page)
		}
	})

	test('the speed label includes zero and the server clamps an out-of-range RPC value', async ({ page }) => {
		test.setTimeout(90_000)
		await open(page)
		try {
			await setSpeed(page, 0)
			await expect(page.getByText('Firehose (0 events/sec)')).toBeVisible()

			// A normal range fill cannot exceed max=50: the browser clamps it
			// before onchange. setRawSpeed only removes that client-side cap; it
			// still drives the page's real handleSpeedChange -> setSpeed RPC path.
			await setRawSpeed(page, 77)
			await expect(page.getByText('Firehose (77 events/sec)')).toBeVisible()
			// The label above is optimistic local state. A fresh hydration is the
			// server oracle and must expose setSpeed's retained upper clamp.
			await page.waitForTimeout(1_000)
			await page.reload()
			await waitForWS(page)
			await expect(page.getByTestId('speed-input')).toHaveValue('50', { timeout: 10_000 })
			await expect(page.getByText('Firehose (50 events/sec)')).toBeVisible()
		} finally {
			await restoreDefaults(page)
		}
	})

	test('the speed value controls the firehose event rate', async ({ page }) => {
		// Two 7s samples plus settling time leave several cron ticks on both
		// sides while keeping this much cheaper than the window-decay coverage.
		test.setTimeout(120_000)
		await open(page)
		try {
			await expectHydrated(page)
			await setBias(page, 'uniform')

			const growthAt = async (speed) => {
				await setSpeed(page, speed)
				await expect(page.getByText(`Firehose (${speed} events/sec)`)).toBeVisible()
				// Let an in-flight 1 Hz tick finish under the preceding speed before
				// taking the baseline. Both samples then span the same seven ticks.
				await page.waitForTimeout(2_000)
				const before = await total(page, 'lb-lifetime')
				await page.waitForTimeout(7_000)
				return (await total(page, 'lb-lifetime')) - before
			}

			const lowGrowth = await growthAt(5)
			const highGrowth = await growthAt(25)
			// Lifetime never resets. Its rendered top five receive roughly 5/12
			// of all events, so a 5x input should comfortably clear this included
			// 3x boundary despite cron phase and random item selection.
			expect(lowGrowth).toBeGreaterThanOrEqual(5)
			expect(highGrowth).toBeGreaterThanOrEqual(30)
			expect(highGrowth).toBeGreaterThanOrEqual(lowGrowth * 3)
		} finally {
			await restoreDefaults(page)
		}
	})

	test('all four windows populate from the firehose with a correctly ordered top-5', async ({ page }) => {
		// Worst case: 15s WS + four sequential 15s panel polls + 15s row-count.
		test.setTimeout(120_000)
		await open(page)
		// Default speed=5 over the 12-item pool: every window accumulates
		// counts and publishes a top-5 within a few cron ticks.
		for (const panel of ['lb-last10s', 'lb-last1min', 'lb-thisMinute', 'lb-lifetime']) {
			// Assert on the snapshot the poll passed on rather than waiting for
			// -rows and then re-reading: one coherent read per panel, with no gap
			// for a republish to land in.
			let snapshot = []
			await expect.poll(async () => {
				snapshot = await rows(page, panel)
				return snapshot.length
			}, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
			const counts = snapshot.map((r) => r.count)
			expect(counts.length).toBeLessThanOrEqual(5)
			expect(counts.every((c) => Number.isInteger(c) && c > 0)).toBe(true)
			// The `top` compute sorts by count descending - the rendered order
			// must match, not just contain the right items.
			expect(counts).toEqual([...counts].sort((x, y) => y - x))
			expect(snapshot.map((r) => r.rank)).toEqual(snapshot.map((_, i) => i + 1))
			for (const row of snapshot) {
				expect(row.progress).toBeGreaterThanOrEqual(0)
				expect(row.progress).toBeLessThanOrEqual(100)
				expect(row.progress).toBeCloseTo((row.count / counts[0]) * 100, 4)
			}
			// Valid aggregate rows always carry positive counts (asserted above),
			// so leaderCount is positive whenever a bar exists. The markup's
			// leaderCount=0 arm is defensive only: zero-data renders the separate
			// empty branch and provides no progress element to exercise through UI.
		}

		// The top-5 cap over a 12-item pool is this page's contract and this
		// test's name. The check above bounds the row count from ABOVE only, so
		// it catches a compute widened to slice(0, 12) but not one narrowed to
		// slice(0, 3) - nothing else in either tier catches the narrowing.
		// The lifetime slice has no boundary timer, so it is the one panel
		// guaranteed to hold all 12 items and render a full 5 (thisMinute
		// legitimately shows fewer for a few seconds after a boundary). Its
		// counts also carry a real spread,
		// which the generic ordering check above is not guaranteed to have: a
		// single row satisfies a descending assertion trivially.
		await expect(page.getByTestId('lb-lifetime-row')).toHaveCount(5, { timeout: 15_000 })
		const life = (await rows(page, 'lb-lifetime')).map((r) => r.count)
		expect(life).toEqual([...life].sort((x, y) => y - x))
	})

	test('both sliding windows decay on their own clocks when the firehose stops; lifetime keeps publishing', async ({ page }) => {
		// Worst case: 35s before the pause (15s WS + 10s rows + 10s lifetime
		// rows), then everything up to the last1min decay is pinned to an
		// ABSOLUTE pause+80s deadline rather than summing relative timeouts,
		// then 10s refill + 10s lifetime climb + 5s bounded restore = ~140s.
		// Navigations are not counted here - nothing in this file bounds a
		// goto, by choice; see open().
		test.setTimeout(200_000)
		await open(page)
		try {
			// Firehose populates the windows.
			await expect(page.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByTestId('lb-lifetime-rows')).toBeVisible({ timeout: 10_000 })

			await setSpeed(page, 0)
			const pausedAt = Date.now()

			// Lower bound on last10s: 5s of silence in, it must STILL hold events.
			// Every other assertion here only bounds the window from above, so a
			// window misconfigured to 2s would empty faster and sail through them.
			await page.waitForTimeout(5_000)
			await expect(page.getByTestId('lb-last10s-rows')).toBeVisible()

			// Upper bound: every event ages out of the 10s window (16s covers the
			// window length plus slide-boundary slack)...
			await expect(page.getByTestId('lb-last10s-empty')).toBeVisible({ timeout: 16_000 })
			// ...while the 60s window still holds the very same events at that
			// moment...
			await expect(page.getByTestId('lb-last1min-rows')).toBeVisible()
			// ...and is still holding them FORTY seconds after the pause. This is
			// last1min's own LOWER bound, and without it the window has none: the
			// assertion above only says "still holding when last10s has gone",
			// which is satisfied ~11s in, so a window mistyped to 20s or 30s
			// passes it and then empties well inside the upper bound below.
			// Measured from the pause rather than from here, because the
			// preceding assertions consume an unknown slice of it.
			// 40s rather than 30s for margin, not for a subtle timing reason: a
			// bucket is cleared one full ring after it became head, so a window
			// of duration D evicts its last event in (last + D - slideMs, last +
			// D]. For a 30s mistype that interval ENDS at pause+30, so a
			// checkpoint sitting exactly on the boundary is decided by which
			// side of a slide tick the read lands on. At pause+40 the exclusion
			// is unambiguous. A healthy 60s window holds until at least
			// pause+54, and the checkpoint can itself be reached as late as
			// pause+41 if every preceding assertion runs to its timeout, so the
			// real margin is ~13s rather than the ~16s a nominal reading gives.
			await page.waitForTimeout(Math.max(0, pausedAt + 40_000 - Date.now()))
			await expect(page.getByTestId('lb-last1min-rows')).toBeVisible()
			// ...and then empties on its OWN clock about a minute in - by an
			// ABSOLUTE deadline measured from the pause, not a relative timeout.
			// A relative timeout drifts with however long the assertions above
			// took, which is exactly how the previous version of this comment
			// ended up claiming a tighter upper bound than the code delivered.
			// A healthy window is empty by ~pause+61 (12 buckets of 5s; a bucket
			// is cleared one full ring after it became head), so pause+80 keeps
			// ~19s of margin. What that upper bound excludes is a DRAIN of 80s
			// or more, which is not the same as a durationMs of 80s: eviction
			// starts one slide early, so an 80s/5s window can render empty from
			// pause+75 and would still pass here. Guaranteed exclusion begins
			// above ~85s of durationMs. With the checkpoint above, last1min is
			// bracketed to (40s, 80s) of drain from the pause - which rules out
			// a 10s duration below and a lifetime/tumbling mistype above, the
			// latter decisively rather than by a margin. A window with no slide ring
			// never republishes at all once the firehose stops, so its panel
			// would freeze at the last frame and never go empty: this assertion
			// is the one thing here that tells "still holding" from "not
			// updating".
			await expect(page.getByTestId('lb-last1min-empty'))
				.toBeVisible({ timeout: Math.max(5_000, pausedAt + 80_000 - Date.now()) })

			// Baseline for the climb assertion, taken HERE - inside the silence,
			// immediately before the restart - and NOT before the pause.
			//
			// Measured over four pause cycles, a pre-pause baseline and the
			// reading at restart came out identical every time (gap 0). The
			// mechanism is tick PHASE, not speed: getSpeed() is read at the top
			// of each 1 Hz tick and `speed <= 0` returns before any publish, so a
			// write landing in the ~900ms between ticks emits nothing further.
			// Four zeros is therefore unremarkable rather than surprising. A
			// pre-pause baseline is thus not observably stale here - but it is
			// correct only by ACCIDENT of that timing. A tick that does land in
			// the gap emits `speed` events, each hitting a currently rendered
			// item with p = 5/12, and the climb poll's first read would then
			// clear the baseline without the restarted firehose having
			// contributed anything - passing for a lifetime frozen at the pause.
			// Read here the null is provably still rather than accidentally
			// still: the firehose has been silent for over a minute (both
			// sliding windows have drained) and lifetime has no timer of its
			// own, so nothing can have moved it. A frozen slice cannot cross
			// this baseline and the poll goes red.
			const lifePaused = await total(page, 'lb-lifetime')
			expect(lifePaused).toBeGreaterThan(0)

			// Restarting the firehose refills the sliding window.
			await setSpeed(page, 20)
			await expect(page.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 10_000 })

			// Only NOW can lifetime be checked, and only for LIVENESS. A lifetime
			// window has no timer of its own (the framework arms boundary timers
			// for tumbling and slide timers for sliding, and neither for
			// lifetime), so its only publish path is an incoming event: with the
			// firehose stopped, nothing can update that panel, and asserting its
			// rows were still visible - as this test used to - merely asserted
			// that the browser had not repainted. That was unfalsifiable. Against
			// a restarted firehose a frozen or unregistered lifetime slice never
			// moves past the paused baseline, so this goes red for it.
			// It does NOT prove lifetime avoided a reset: a reset slice climbs
			// from zero and can clear a modest baseline inside this poll
			// (confirmed by mutation - retyping lifetime as tumbling leaves this
			// assertion green). The no-reset property is pinned by the tumbling
			// test's same-instant check instead, which that same mutation reddens.
			await expect.poll(() => total(page, 'lb-lifetime'), { timeout: 10_000 })
				.toBeGreaterThan(lifePaused)
		} finally {
			// Best-effort AND bounded: neither a throw nor a hang here may replace
			// the body's real assertion error. The afterEach is the guaranteed
			// restore.
			await setSpeed(page, 5, RESTORE).catch(() => {})
		}
	})

	test('the tumbling window resets on the minute boundary while lifetime keeps climbing', async ({ page }) => {
		// Worst case: 15s WS + 40s to accumulate + 70s to the boundary + 15s for
		// the lifetime climb + 70s to re-accumulate + 70s to the second boundary
		// = 280s, plus the initial navigation. Runs at the default speed and
		// touches no control, so it needs no restore of its own. The second
		// boundary is what pins the period; the 330s slot leaves 50s for a cold
		// dev-server navigation instead of excluding that cost from the budget.
		test.setTimeout(330_000)
		await open(page)

		// Witness a FULL tumbling window first. This is the included side of the
		// transition: polling straight for a low count would be satisfied by a
		// window that had simply never filled, which is the stale-state pass the
		// boundary rule exists to prevent. ~50 summed across the top-5 is ~20s
		// of firehose at the default speed of 5.
		let before = 0
		await expect.poll(async () => {
			before = await total(page, 'lb-thisMinute')
			return before
		}, { timeout: 40_000 }).toBeGreaterThanOrEqual(50)
		const lifeBefore = await total(page, 'lb-lifetime')
		// Without a floor, an unrendered lifetime panel reads 0 and every
		// comparison below degenerates to 0-vs-0 - passing against a dead panel.
		expect(lifeBefore).toBeGreaterThan(0)

		// The firehose never stops during this test, so a collapsing total can
		// ONLY be the tumbling reset - and it discriminates against BOTH of the
		// other window types: lifetime would never drop, and a 60s SLIDING
		// window fed at a constant rate holds a steady total instead of
		// collapsing. A wall-clock boundary is guaranteed within 60s; polling
		// for the drop rather than computing the boundary keeps this immune to
		// clock skew between the runner and the server. (The boundary publishes
		// the closing window's PEAK, not an empty one, and the reset that
		// follows is silent - so the collapse is only rendered on the next
		// event. The firehose is a 1 Hz cron emitting `speed` events per tick,
		// so that is up to a second later, which the ~1s poll interval absorbs;
		// the fresh window is far below half either way.)
		// The row guard is the one the share predicates carry, for the same
		// reason: total() reads 0 for a panel rendering its empty branch, and 0
		// is below any bar - so a thisMinute emptied by something OTHER than a
		// boundary (a subscription re-attach delivering null, a stray
		// navigation) satisfies a bare magnitude check without a reset having
		// happened. A fresh tumbling window renders rows within one 1 Hz tick,
		// so the guard costs nothing on the passing path.
		//
		// The bar tracks the running PEAK rather than staying at half of
		// `before`. `before` is whatever the window happened to hold when it
		// crossed 50, so half of it is a bar the fresh window re-crosses about
		// twelve seconds after the reset - and once the period assertion below
		// exists, a stall longer than that stops being a slow run and becomes a
		// red one, because the missed boundary pushes the measured period to
		// ~120s. Against the real pre-boundary peak (~120 at the default speed)
		// the sub-threshold window is nearer thirty seconds. Same discrimination,
		// several times the tolerance.
		let peak = before
		await expect.poll(async () => {
			const r = await rows(page, 'lb-thisMinute')
			const sum = r.reduce((acc, x) => acc + x.count, 0)
			if (r.length >= 3 && sum > peak) peak = sum
			return r.length >= 3 && sum < peak / 2 ? 'dropped' : `peak=${peak} n=${r.length} sum=${sum}`
		}, { timeout: 70_000 }).toBe('dropped')
		const firstDrop = Date.now()

		// Same instant, the other side of the pitch: lifetime did NOT reset on
		// the boundary the tumbling window just reset on. >= is deliberate here -
		// at the drop instant as little as ~0.4s may have elapsed since
		// lifeBefore, so demanding a strict increase would flake. This
		// comparison is what owns the no-reset claim.
		const lifeAtDrop = await total(page, 'lb-lifetime')
		expect(lifeAtDrop).toBeGreaterThanOrEqual(lifeBefore)

		// ...and it is CLIMBING, not merely frozen at a stale value: >= alone is
		// satisfied by a lifetime slice that stopped reducing altogether, which
		// no other assertion in this suite would catch.
		//
		// The baseline has to be lifeAtDrop, NOT lifeBefore. lifeBefore is read
		// when thisMinute crosses 50, and this poll runs only after the next
		// wall-clock boundary - so it is stale by whatever is left of the
		// minute. Measured on one ISOLATED run of this test - lifetime is a
		// process-lifetime accumulator that is never reset and never persisted,
		// so in a full-tier run the same reads are far larger and the absolute
		// numbers here do not carry over: baseline 68, value at the drop 168,
		// i.e. 42s of staleness and 100 counts of drift. Against lifeBefore this
		// poll was therefore satisfied a hundred counts before it started, and
		// a lifetime frozen at any point after the baseline would have passed;
		// it demanded a real increase only in the rare case where the crossing
		// happened within a second of the boundary. Against lifeAtDrop - read
		// milliseconds earlier, at the drop - a frozen slice never crosses and
		// the poll goes red at 15s, while a live one clears it in a second or
		// two (5 events per tick at the default speed, each landing on a
		// rendered item with p = 5/12).
		//
		// This also retires the unstated premise above: a firehose that had gone
		// silent could not move lifetime at all, so the collapse really was the
		// boundary.
		await expect.poll(() => total(page, 'lb-lifetime'), { timeout: 15_000 })
			.toBeGreaterThan(lifeAtDrop)

		// Everything so far pins that thisMinute is TUMBLING - it collapses,
		// which neither a lifetime nor a constant-rate sliding window does. It
		// does not pin the PERIOD, and the test name claims a minute. A window
		// retyped to { durationMs: 30_000 } clears the accumulate gate and drops
		// well inside the 70s poll, so the assertions above would not notice it;
		// nothing else in either tier reads period: 'minute'.
		// Consecutive tumbling resets are exactly one period apart, so timing the
		// NEXT boundary closes that. The bracket is deliberately wide relative to
		// the ~1s poll granularity and tolerant of a slow first observation,
		// while still excluding every plausible mistype: 30s and 45s fall below
		// it, two minutes above.
		let secondPeak = 0
		await expect.poll(async () => {
			secondPeak = await total(page, 'lb-thisMinute')
			return secondPeak
		}, { timeout: 70_000 }).toBeGreaterThanOrEqual(50)
		// Same running-peak bar as the first drop, and for the same reason: a
		// stall here would push the measured period past the bracket below.
		await expect.poll(async () => {
			const r = await rows(page, 'lb-thisMinute')
			const sum = r.reduce((acc, x) => acc + x.count, 0)
			if (r.length >= 3 && sum > secondPeak) secondPeak = sum
			return r.length >= 3 && sum < secondPeak / 2 ? 'dropped' : `peak=${secondPeak} n=${r.length} sum=${sum}`
		}, { timeout: 70_000 }).toBe('dropped')
		const period = Date.now() - firstDrop
		expect(period).toBeGreaterThan(50_000)
		expect(period).toBeLessThan(70_000)
	})

	test('monopoly bias makes Midnight Drift dominate the sliding window, and uniform restores the spread', async ({ page }) => {
		// Worst case: 15s WS + 10s rows + 20s hydration gate (rows then name) +
		// 15s pre-state gate + 2x10s class assertions + 20s dominance poll +
		// 2x10s class assertions + 20s un-dominance poll + 10s of bounded
		// restores in the finally = 150s.
		test.setTimeout(170_000)
		await open(page)
		try {
			await expect(page.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 10_000 })
			await expectHydrated(page)

			// A brisk firehose so the window turns over quickly under the new bias.
			await setSpeed(page, 25)

			// Witness the NOT-dominant pre-state before touching the bias, so the
			// poll below waits for a transition this test caused. Polling straight
			// for dominance would be satisfied at t=0 by a window already showing
			// monopoly (a crashed run that never hit its finally), passing without
			// the action under test doing anything. The gate demands a POPULATED
			// non-dominant panel: "not dominant" alone is true of an empty one,
			// which would witness a pre-state that is really just an absent one.
			await expect.poll(async () => {
				const s = await leaderShare(page, 'lb-last10s')
				return populated(s) && !dominant(s) ? 'spread pre-state' : describeShare(s)
			}, { timeout: 15_000 }).toBe('spread pre-state')

			await setBias(page, 'monopoly')
			// The clicked bias is marked active; the previous one is not.
			await expect(page.getByTestId('bias-monopoly')).toHaveClass(/btn-primary/)
			await expect(page.getByTestId('bias-uniform')).not.toHaveClass(/btn-primary/)

			// ~75% of events now go to 'midnight' (~18.75/s at speed 25), which
			// overtakes any residual leader well inside the 10s window. Require
			// the dominance share too: first place alone is reachable by uniform
			// noise, a >50% share of the rendered counts is not.
			await expect.poll(async () => {
				const s = await leaderShare(page, 'lb-last10s')
				return dominant(s) ? 'dominant' : describeShare(s)
			}, { timeout: 20_000 }).toBe('dominant')

			// Now drive the THIRD bias control with a real outcome. Uniform is
			// otherwise only ever clicked in a finally, so a setBias('uniform')
			// that threw - or a uniform weighting that stopped working - would
			// leave this whole suite green. (The class assertions are the click's
			// optimistic state; the poll below is what requires the server.)
			await setBias(page, 'uniform')
			await expect(page.getByTestId('bias-uniform')).toHaveClass(/btn-primary/)
			await expect(page.getByTestId('bias-monopoly')).not.toHaveClass(/btn-primary/)
			// The bar is 0.4, not the 0.5 used above, and the difference matters:
			// the dominance poll exits at the FIRST read across 0.5, so this poll
			// starts at ~0.5 with the monopoly block still sitting in the 10s
			// ring, and a >0.5 bar would be satisfied by a single noisy read
			// rather than by a real turnover. Uniform settles at ~0.24, so 0.4 is
			// below anything the monopoly residue can produce and is reached only
			// once the ring has actually turned over (~9s, inside the budget).
			//
			// `spread` requires rows as well as the low share, and that guard is
			// what this assertion rests on: a share below a bar is also what an
			// EMPTY panel reports, so without it a firehose that had stopped
			// emitting entirely would be read as uniform restoring the spread -
			// the precise regression this assertion was added to catch.
			await expect.poll(async () => {
				const s = await leaderShare(page, 'lb-last10s')
				return spread(s) ? 'spread' : describeShare(s)
			}, { timeout: 20_000 }).toBe('spread')
		} finally {
			// Best-effort AND bounded - see restoreDefaults.
			await restoreDefaults(page)
		}
	})

	test('hot bias marks the active control and gives the three hot items the top three slots', async ({ page }) => {
		// Worst case: 15s WS + 10s rows + 20s hydration gate (rows then name) +
		// 15s pre-state gate + 2x10s class assertions + 30s hot poll + 10s of
		// bounded restores in the finally = 120s.
		test.setTimeout(140_000)
		await open(page)
		try {
			await expect(page.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 10_000 })
			await expectHydrated(page)

			await setSpeed(page, 25)

			// Witness the not-hot pre-state, exactly as the monopoly test does -
			// populated, and not yet hot-led. Under uniform the three hot items
			// are ~63% of the rendered top-5 at best (and often absent from it);
			// only a live hot bias reaches 0.75. The row requirement matters for
			// the same reason it does there: an empty panel reports share 0 and
			// would satisfy a bare "not above the bar" gate.
			await expect.poll(async () => {
				const s = await hotSignal(page, 'lb-last10s')
				return populated(s) && !hotLed(s) ? 'cold pre-state' : describeHot(s)
			}, { timeout: 15_000 }).toBe('cold pre-state')

			await setBias(page, 'hot')
			await expect(page.getByTestId('bias-hot')).toHaveClass(/btn-primary/)
			await expect(page.getByTestId('bias-uniform')).not.toHaveClass(/btn-primary/)

			// Hot weights Aurora 25% / Crimson 20% / Echo 15% (60% combined) vs
			// ~4.4% each for the other nine. Once the 10s window turns over (and
			// the previous test's residue ages out) the top three slots ARE the
			// three hot items: steady state ~62/50/38 per window at speed 25 vs
			// ~11 for any cold item. Order among the three is not asserted (their
			// gaps are ~1.3 sigma apart, so ordering would flake) - but podium
			// membership alone is not enough either: three specific items hold
			// the top three by uniform chance 1-in-220 per window turnover, which
			// over a 30s poll is a percent-level false pass against a dead
			// setBias. The combined share is the magnitude guard that closes it.
			await expect.poll(async () => {
				const s = await hotSignal(page, 'lb-last10s')
				return hotLed(s) ? 'hot' : describeHot(s)
			}, { timeout: 30_000 }).toBe('hot')
		} finally {
			// Best-effort AND bounded - see restoreDefaults.
			await restoreDefaults(page)
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			// Full-width slider: height is the constrained axis.
			await expectTouchTarget(page.getByTestId('speed-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('bias-uniform'))
			await expectTouchTarget(page.getByTestId('bias-hot'))
			await expectTouchTarget(page.getByTestId('bias-monopoly'))
		} finally {
			await context.close()
		}
	})
})
