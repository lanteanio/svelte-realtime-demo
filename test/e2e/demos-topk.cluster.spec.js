import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'
import {
	RESTORE, NAV, setSpeed, setBias, expectHydrated,
	leaderShare, populated, dominant, describeShare,
	hotSignal, hotLed, describeHot, restoreTopkDefaults
} from './topk-helpers.js'

// Cross-replica coverage for /demos/topk: two tabs forced onto DIFFERENT
// SO_REUSEPORT replicas (instance A vs instance B) against shared Redis +
// Postgres. What this tier proves that the single-instance suite cannot:
//   1. The bias control is a cluster-shared Redis key: the firehose follows a
//      bias set from A AND one set from B. The control is driven from BOTH
//      tabs on purpose. Whichever replica wins the leader election is the one
//      running the cron, so exactly one of the two directions is a write from
//      the NON-leader - the only case that actually requires a shared key. A
//      one-directional test passes against a process-local key whenever the
//      writer happens to be the leader.
//      In the LOCAL harness that is not a coin toss: run-local-e2e.mjs starts
//      instance A and waits for it to serve before starting B, and the leader
//      lease is claimed with SET NX on the first tick during init - so A leads
//      for the whole run. Direction 1 (A writes, A's cron reads) would
//      therefore pass against a process-local key, and DIRECTION 2 - the write
//      from B - is the one carrying the claim locally. Both directions are
//      still driven, because against a real multi-replica deployment the
//      election is not knowable in advance and either one may be the
//      non-leader write.
//   2. Pausing the firehose from A (speed 0) drains the sliding window on a
//      tab connected to B, and restarting it from A refills that window. No
//      claim is made about B's LIFETIME window in either direction: with the
//      firehose stopped nothing can update that panel, and once it restarts
//      the panel interleaves both replicas' totals, so no pair of reads can
//      tell a climb apart from a switch of replica. See the comment on the
//      restart in test 2.
//
// What this tier deliberately does NOT claim:
//   - That the firehose is a cluster SINGLETON. Nothing here discriminates
//     it: if every replica ran the cron unguarded, each aggregate would
//     simply see N times the events and every assertion below would still
//     pass, because they are all scale-invariant (shares and orderings, not
//     rates). Nothing else in the e2e suite covers it either -
//     demos-cluster-cron.spec.js is about the /demos/cluster-cron page's own
//     tick and asserts a lower bound on rows, not singleton-ness. Two nearer
//     siblings, demos-news.cluster.spec.js and demos-notifications.cluster
//     .spec.js, have headers that READ as claiming singleton coverage; neither
//     actually asserts it (news asserts a headline visible on B; notifications
//     asserts arrival plus a 'fired' log, and says as much in its own header).
//     So the topk firehose's leader gating is unasserted anywhere; do not read
//     this file - or those two - as covering it.
//   - That B's OWN aggregate reduced the events. It cannot be shown from a
//     browser. Both replicas' aggregates publish to the same derived topics,
//     and those publishes relay cluster-wide (svelte-realtime reactive.js
//     routes the window publish through platform.publish, which the bus wraps
//     and relays unless relay:false; the receiving instance re-publishes to
//     its own local subscribers). So a frame rendered on B may have been
//     computed by A's aggregate, and no DOM assertion can attribute it.
//     Asserting both tabs does not rescue that - because the OUTPUT relays,
//     asserting both proves neither. Both are still asserted below because
//     the converged state reaching each replica's tab is worth pinning; the
//     attribution is simply not part of the claim.
//   - That the SPEED key specifically is shared. Test 2's observable (pausing
//     from A empties B's sliding window) holds under either election branch,
//     so it does not discriminate a process-local speed key. Claim 1 covers
//     the shared-control mechanism; both keys go through the same Redis path.
//
// Raw counts are never compared BETWEEN A and B. The reason is stronger than
// "each replica keeps its own state": because BOTH replicas' aggregates
// publish to the same derived topic AND both relay, each tab renders a
// last-writer-wins interleaving of both replicas' window states - so a single
// tab's counts are not even self-consistent between two reads. Ordering is the
// only thing expected to AGREE between the two tabs.
// Counts are not untouched, though, and it would be wrong to claim so. Every
// count assertion below is read WITHIN a single frame - one rows() call - and
// that is what makes each of them safe under the interleaving:
//   - RATIOS (dominant / spread), computed inside whichever replica's frame
//     produced that render; a bias reshapes both replicas alike.
//   - the absolute floor inside `populated` (summed counts >= 10), which only
//     has to separate a live panel from an empty or degenerate one. Both
//     replicas' last10s windows carry the same relayed events, so neither sits
//     anywhere near it.
// NOTHING here compares counts ACROSS two reads. See the restart comment in
// test 2 for why such a comparison is not testable on this tier.
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

// `opts` is passed through to goto, and only the teardown path uses it: no
// navigationTimeout is configured, so an unbounded goto in the afterEach would
// blow the hook's slot regardless of the loop's wall-clock deadline. Test
// bodies keep the unbounded default on purpose.
async function openAt(page, origin, opts) {
	await page.goto(`${origin}/demos/topk`, opts)
	await waitForWS(page)
}

test.describe('cluster: /demos/topk cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	// Reset the shared speed/bias keys after each cross-replica test via a
	// fresh context on A - the keys are global, and on a TIMEOUT a test's own
	// finally runs against a page the runner has already torn down, so its
	// restores fail. Best-effort: teardown never fails a test.
	test.afterEach(async ({ browser }) => {
		if (!process.env.INSTANCE_B) return
		const restored = await restoreTopkDefaults(browser, {
			baseURL: INSTANCE_A,
			open: (page, opts) => openAt(page, INSTANCE_A, opts)
		})
		// Exhausting the loop silently leaves the NEXT test to fail for a reason
		// unrelated to its own subject. Not a failure, but not invisible either.
		if (!restored) console.warn('[topk cluster afterEach] speed/bias NOT restored - the next test may inherit them')
	})

	test('a bias set on either replica steers the shared firehose so both replicas converge', async ({ browser }) => {
		// Worst case: 2x15s WS + 2x12s rows + 2x20s hydration gates (rows then
		// name, 10s each) + 15s pre-state gate + 25s convergence + 25s for the
		// reverse direction + 10s of bounded restores in the finally = ~169s,
		// plus two navigations. The cluster tier runs both replicas under `vite
		// dev`, so each one compiles /demos/topk independently on first hit; the
		// 220s slot leaves ~51s for those cold navigations rather than treating
		// them as free.
		test.setTimeout(220_000)
		// Declared outside and created INSIDE the try: created before it, a
		// throw from B's newContext or from either newPage would skip the
		// finally entirely and leak A for the lifetime of the worker, since
		// `browser` is a worker-scoped fixture.
		let ctxA, ctxB
		try {
			ctxA = await browser.newContext({ baseURL: INSTANCE_A })
			ctxB = await browser.newContext({ baseURL: INSTANCE_B })
			const a = await ctxA.newPage()
			const b = await ctxB.newPage()
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			// Both replicas are subscribed and already seeing the shared firehose.
			await expect(b.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 12_000 })
			await expect(a.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 12_000 })
			// Both tabs, since both are read by the name-based polls below.
			await expectHydrated(a)
			await expectHydrated(b)

			try {
				// Direction 1: A drives the shared bias.
				await setSpeed(a, 25)

				// Witness the NOT-dominant pre-state on both tabs before touching
				// the bias, so the convergence poll waits for a transition this
				// test caused. Polling straight for dominance would be satisfied at
				// t=0 by a leaked monopoly key (a crashed run that never hit its
				// finally), passing without the action under test doing anything.
				// Both panels must be POPULATED and non-dominant: "not dominant" is
				// also true of an empty panel, so without the row requirement this
				// would witness an absent pre-state rather than a spread one.
				await expect.poll(async () => {
					const [sa, sb] = await Promise.all([leaderShare(a, 'lb-last10s'), leaderShare(b, 'lb-last10s')])
					return populated(sa) && populated(sb) && !dominant(sa) && !dominant(sb)
						? 'both spread pre-state'
						: `A ${describeShare(sa)} | B ${describeShare(sb)}`
				}, { timeout: 15_000 }).toBe('both spread pre-state')

				await setBias(a, 'monopoly')

				// The firehose now emits ~75% 'midnight', and the resulting
				// leaderboard converges on Midnight Drift on BOTH tabs - including
				// the one on the replica that never touched a control. Require the
				// dominance share too: first place alone is reachable by uniform
				// noise, a >50% share of the rendered counts is not. See the header
				// for what this does and does not prove: the frame B renders is not
				// attributable to B's own aggregate.
				await expect.poll(async () => {
					const [sa, sb] = await Promise.all([leaderShare(a, 'lb-last10s'), leaderShare(b, 'lb-last10s')])
					return dominant(sa) && dominant(sb) ? 'both dominant' : `A ${describeShare(sa)} | B ${describeShare(sb)}`
				}, { timeout: 25_000 }).toBe('both dominant')

				// Direction 2: the SAME control, driven from B this time. This is
				// what makes claim 1 leader-independent - see the header. Exactly
				// one of the two directions is a write from the non-leader, and
				// only that one needs the key to be shared. In the local harness
				// that is THIS direction: A boots first and takes the lease with
				// SET NX, so direction 1 above was the leader writing a key its
				// own cron reads, which a process-local key would satisfy. Against
				// a real deployment the election is not knowable in advance, which
				// is why both directions are driven rather than just this one.
				// Drive a NON-default target from B. Uniform is the server fallback
				// when the key is missing or invalid, so a lost non-leader write
				// can still appear to "restore uniform." Hot is reachable only if
				// B's write genuinely reaches the key the leader reads. Starting
				// from monopoly also makes the hot poll wait for a transition this
				// action caused rather than accepting the current state.
				await setBias(b, 'hot')
				await expect.poll(async () => {
					const [sa, sb] = await Promise.all([hotSignal(a, 'lb-last10s'), hotSignal(b, 'lb-last10s')])
					return hotLed(sa) && hotLed(sb) ? 'both hot' : `A ${describeHot(sa)} | B ${describeHot(sb)}`
				}, { timeout: 25_000 }).toBe('both hot')
			} finally {
				// Both best-effort: a bias click that fails on a LIVE page must not
				// also skip the speed restore, and a throw in either would replace
				// the body's real assertion error with a teardown error. (A
				// torn-down page fails both; afterEach covers it.) The sibling
				// finally in the next test deliberately does NOT swallow - that one
				// restores a precondition for assertions that follow it, so a
				// failure there has to surface, not be papered over.
				await setBias(a, 'uniform', RESTORE).catch(() => {})
				await setSpeed(a, 5, RESTORE).catch(() => {})
			}
		} finally {
			// allSettled, not two sequential awaits: if closing A rejects - which
			// is likeliest exactly when a cross-replica test has just failed and
			// the browser is already gone - a sequential pair would skip B's
			// close entirely and propagate the close error in place of the real
			// assertion failure. Same masking this file guards against everywhere
			// else, and the single-instance sibling already gets it right with a
			// caught close.
			await Promise.allSettled([ctxA?.close(), ctxB?.close()])
		}
	})

	test('pausing the firehose from A drains the sliding window on B, and restarting it from A refills B', async ({ browser }) => {
		// The title names only what is asserted. It does not say "B's lifetime
		// keeps publishing": the header explains that a frame rendered on B may
		// have been computed by A's aggregate and no DOM assertion can attribute
		// it, and the comment on the restart below explains why no lifetime
		// assertion is testable here at all.
		//
		// Worst case: 2x15s WS + 12s rows + 18s decay + 10s last1min-still +
		// 5s bounded restore + 15s refill = ~90s, plus two navigations.
		test.setTimeout(130_000)
		// Declared outside and created INSIDE the try: created before it, a
		// throw from B's newContext or from either newPage would skip the
		// finally entirely and leak A for the lifetime of the worker, since
		// `browser` is a worker-scoped fixture.
		let ctxA, ctxB
		try {
			ctxA = await browser.newContext({ baseURL: INSTANCE_A })
			ctxB = await browser.newContext({ baseURL: INSTANCE_B })
			const a = await ctxA.newPage()
			const b = await ctxB.newPage()
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			// The shared firehose has populated the window this test acts on. The
			// lifetime panel is deliberately NOT gated here: since the lifetime
			// assertion was removed (see the restart below) waiting on it would
			// prove nothing the last10s gate does not, cost 12s of budget, and
			// quietly re-assert something about B's lifetime that the header says
			// this tier does not claim.
			await expect(b.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 12_000 })

			let restoreError
			try {
				// A stops the firehose (shared SPEED_KEY=0); the cron's next tick
				// emits nothing, so every event ages out of the 10s sliding window
				// rendered on the other replica's tab...
				await setSpeed(a, 0)
				await expect(b.getByTestId('lb-last10s-empty')).toBeVisible({ timeout: 18_000 })
				// ...while the 60s sliding window still holds those same events at
				// that moment.
				await expect(b.getByTestId('lb-last1min-rows')).toBeVisible()
			} finally {
				// This restore is a precondition for the refill assertion below, so
				// unlike every other teardown in these files its failure has to
				// SURFACE rather than be swallowed. It must not surface by
				// replacing a failure from the body, though: if the decay assertion
				// above has just failed and page A is no longer actionable, an
				// unguarded restore throws a 5s TimeoutError from this finally and
				// the run reports "locator.fill timeout" on the slider instead of
				// the cross-replica decay regression that actually happened. So it
				// is captured here and rethrown after the try, which is reached
				// only when the body succeeded.
				await setSpeed(a, 5, RESTORE).catch((e) => { restoreError = e })
			}
			if (restoreError) throw restoreError

			// ...and the window refills on B once A restarts the firehose. That is
			// the whole post-restart claim on this tier, and the pair of it with
			// the drain above is what makes the drain meaningful: a window that
			// had simply broken would also read empty and never come back.
			await expect(b.getByTestId('lb-last10s-rows')).toBeVisible({ timeout: 15_000 })

			// NO lifetime assertion here, deliberately, and it is worth recording
			// why rather than leaving a future round to re-invent one.
			// Both replicas' aggregates reduce the same relayed events and both
			// publish the lifetime window to the same topic, so B's tab renders
			// whichever frame arrived last and successive reads can come from
			// different replicas. A's aggregate also reduced every event emitted
			// before B's registered (the harness starts A and waits for it to
			// serve HTTP before spawning B), so A's total sits permanently above
			// B's by an offset no constant in this file can bound.
			// A climb is therefore not decidable from two reads: if a read pair
			// straddles replicas the difference is the offset, not growth. That
			// cuts both ways - a pair of slices that had STOPPED ACCUMULATING
			// but were still re-publishing stale values can clear a baseline
			// taken from the lower replica (false pass), and a perfectly healthy
			// pair can need offset/rate seconds to pass a baseline taken from the
			// higher one (false failure). Two attempts to hedge this with a
			// sampled maximum were both unsound; the record is on the card.
			// A sound formulation does exist and is worth naming so it is not
			// mistaken for impossible: if both slices were frozen, every rendered
			// frame would carry one of exactly two fixed vectors, so observing
			// three or more DISTINCT summed totals refutes "both frozen" without
			// needing a baseline - provided it carries the same row guard the
			// rest of this suite uses, because the page renders an empty panel
			// as total 0 (+page.svelte coalesces a null delivery to empty
			// counts) and that would supply a spurious third value on a
			// re-attach. It is omitted because it adds nothing here rather than
			// because it cannot be written. What it
			// proves is that SOME aggregate is still accumulating, and it cannot
			// attribute that to B - the same attribution limit the header states.
			// The single-instance decay test already owns "lifetime resumes
			// climbing after a restart", with one aggregate and no interleaving
			// to confound it.
		} finally {
			// allSettled, not two sequential awaits: if closing A rejects - which
			// is likeliest exactly when a cross-replica test has just failed and
			// the browser is already gone - a sequential pair would skip B's
			// close entirely and propagate the close error in place of the real
			// assertion failure. Same masking this file guards against everywhere
			// else, and the single-instance sibling already gets it right with a
			// caught close.
			await Promise.allSettled([ctxA?.close(), ctxB?.close()])
		}
	})
})
