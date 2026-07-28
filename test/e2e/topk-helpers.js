import { expect } from '@playwright/test'

// Shared helpers for the /demos/topk specs - demos-topk.spec.js and its
// demos-topk.cluster.spec.js sibling.
//
// These live here rather than being copied into both files because of what
// they carry: the bar values below (0.5, 0.4, 0.75) and the population floor
// are MEASURED constants, and the comments justifying them quote sampled
// distributions. Two copies means a future re-tune lands in one file while the
// other goes on asserting the old threshold under a comment claiming it was
// measured - which is the exact class of comment-vs-code drift these specs
// have already had to be corrected for. One definition, one set of numbers.
//
// Page-entry helpers are deliberately NOT here: the single-instance spec opens
// a relative URL and the cluster spec opens an absolute per-replica origin.

// Bounded restore for teardown paths: Playwright defaults actionTimeout to 0,
// so an unbounded fill/click on a live-but-not-actionable control retries
// until the whole test slot expires - and a .catch() cannot rescue that,
// because nothing ever throws. A restore that hangs replaces the body's real
// assertion error with a bare test timeout, which is what those .catch()es
// exist to prevent.
export const RESTORE = { timeout: 5_000 }

// Navigation budget for teardown-path navigations. Neither the config nor
// Playwright's defaults bound a navigation (no navigationTimeout is set), so
// an unbounded goto inside an afterEach would blow the hook's slot no matter
// what wall-clock deadline its loop carries. Test bodies keep the unbounded
// default on purpose - a cold dev-server navigation is slow but not a defect,
// and bounding it there would trade a real signal for a flake.
export const NAV = { timeout: 20_000 }

// The speed slider commits onchange; fill() on a range input fires it.
export async function setSpeed(page, n, opts) {
	await page.getByTestId('speed-input').fill(String(n), opts)
}

// Drive the same onchange/RPC path with a value that a human cannot select.
// The browser enforces max=50 before dispatching input events, so lift that
// DOM constraint for this one write. A reload restores the authored markup
// and lets the caller distinguish the optimistic local value from the value
// that setSpeed() validated and retained on the server.
export async function setRawSpeed(page, n) {
	await page.getByTestId('speed-input').evaluate((el, value) => {
		el.removeAttribute('max')
		el.value = String(value)
		el.dispatchEvent(new Event('change', { bubbles: true }))
	}, n)
}

export async function setBias(page, id, opts) {
	await page.getByTestId(`bias-${id}`).click(opts)
}

// Every signal that matches on an item NAME is dead until myTopkState() lands:
// nameById() falls back to the raw lowercase item id, so an unhydrated page
// renders 'aurora' where HOT_NAMES expects 'Aurora Flux' and 'midnight' where
// the monopoly poll expects 'Midnight Drift'. The page awaits that probe once,
// in onMount, with no catch - and the client rejects an RPC on TIMEOUT or
// DISCONNECTED - so a single lost probe leaves the item list empty for the
// lifetime of the page. Without this gate that failure is indistinguishable
// from a bias that never took effect: every name match goes false, the share
// reads 0, and the poll burns its whole timeout before blaming setBias for a
// hydration fault. All 12 display names are capitalised and all 12 ids are
// lowercase, so the first letter is the discriminator.
// The rows gate comes first for ATTRIBUTION, not for correctness: while the
// lifetime panel renders its empty branch there is no -name element at all, so
// gating straight on the name would burn the full timeout and report a
// hydration fault for a firehose that had simply not produced an event yet -
// the exact misattribution this helper exists to prevent. On the passing path
// it costs nothing - though NOT because every caller has already witnessed
// live rows: some call sites run it as their first read after a load. What
// makes it free is that the lifetime slice has no boundary timer and the
// firehose has been running since process boot, so that panel is non-empty by
// the time any test opens the page.
// NOTE ON THE TWO 10s WAITS: the afterEach hooks in both specs derive an exact
// worst case for themselves and this helper is 20s of it. Raising either
// timeout pushes those hooks toward their slot, and the arithmetic that would
// go stale now lives in a different file from the constant - which is the very
// drift this module exists to prevent. Change them together.
export async function expectHydrated(page) {
	await expect(page.getByTestId('lb-lifetime-rows')).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('lb-lifetime-name').first())
		.toHaveText(/^[A-Z]/, { timeout: 10_000 })
}

// Shared afterEach backstop for the two specs. `open` is supplied by the
// caller because the main tier uses a relative URL while the cluster tier
// targets an explicit replica. The page/context are recreated INSIDE each
// guarded attempt: a failed or slow initial navigation must not sit outside
// the retry, consume its window, and skip every restore.
//
// One full attempt is bounded to roughly 104s: two 20s navigations, two 15s
// waitForWS calls inside `open`, two 5s writes, the 20s hydration gate above,
// and two 2s readbacks. The retry window is deliberately only 2s: it permits
// another attempt after an immediate context/page failure while keeping the
// worst case near 106s, below the shortest 120s afterEach slot with room for
// context and fixture teardown. The first attempt always runs.
export async function restoreTopkDefaults(browser, { baseURL, open }) {
	let restored = false
	const retryUntil = Date.now() + 2_000
	for (let attempt = 0; attempt < 3 && (attempt === 0 || Date.now() < retryUntil); attempt++) {
		let ctx
		try {
			ctx = await browser.newContext({ baseURL })
			const page = await ctx.newPage()
			await open(page, NAV)
			await setBias(page, 'uniform', RESTORE)
			await setSpeed(page, 5, RESTORE)

			// Navigate again before reading. The controls optimistically update
			// to the values we just wrote, so same-page readbacks are vacuous;
			// a fresh hydration is what proves the server retained both writes.
			await open(page, NAV)
			await expectHydrated(page)
			const readback = { timeout: 2_000 }
			const speed = await page.getByTestId('speed-input').inputValue(readback)
			const cls = (await page.getByTestId('bias-uniform').getAttribute('class', readback)) ?? ''
			if (speed === '5' && cls.includes('btn-primary')) {
				restored = true
				break
			}
		} catch {
			// Transient: retry only while the short retry window still permits.
		} finally {
			await ctx?.close().catch(() => {})
		}
	}
	return restored
}

// One DOM read for the whole panel: each name is paired with the count from
// the SAME render. Reading the -name and -count testids as two separate
// round-trips would race the aggregate's republish - which lands on EVERY
// event (up to 25/s at speed 25), not just on the 1s slide tick - and pair a
// name with a different snapshot's count.
export async function rows(page, panel) {
	return page.getByTestId(`${panel}-row`).evaluateAll((els, p) =>
		els.map((el) => {
			const rank = Number(el.firstElementChild?.textContent?.trim())
			const progress = Number.parseFloat(el.lastElementChild?.firstElementChild?.style.width ?? '')
			return {
				rank,
				name: el.querySelector(`[data-testid="${p}-name"]`)?.textContent?.trim() ?? '',
				count: Number(el.querySelector(`[data-testid="${p}-count"]`)?.textContent?.trim()),
				progress
			}
		}), panel)
}

// Summed rendered counts - the denominator for every share below, and the
// magnitude signal for the tumbling reset.
export async function total(page, panel) {
	return (await rows(page, panel)).reduce((sum, r) => sum + r.count, 0)
}

// First place plus its share of the summed rendered top-5. Under uniform bias
// any of the 12 items leads the churning window some of the time, so a leader
// NAME alone is a coincidence-prone signal. Measured at speed 25 after a full
// ring turnover: under uniform the leader's share runs median 0.221 / max
// 0.266 (top-5 counts are near-equal, so first place is barely ahead); under
// monopoly it runs min 0.819 / median 0.845 (midnight takes 75% of ALL events
// while the four other rendered items split the rest). Nothing uniform
// produced came within 0.23 of the 0.5 bar, and nothing monopoly produced came
// within 0.3 of it from above.
//
// `n` is the rendered row count and EVERY predicate built on this helper has
// to consult it. The no-data sentinel reads share 0, and 0 satisfies "share
// below a bar" - so an un-dominance check that looked at the share alone would
// report "uniform brought the spread back" for a firehose that had stopped
// emitting altogether (a throwing pickItem, or a dropped leader lease: the 10s
// ring drains in ~10s and the panel renders its empty branch). The dominance
// direction is already safe, because it also requires a NAME and the sentinel
// has none. The predicates are defined once, here, rather than at each call
// site so the guard cannot be dropped from one of them.
export async function leaderShare(page, panel) {
	const r = await rows(page, panel)
	const sum = r.reduce((acc, x) => acc + x.count, 0)
	if (!r.length || !sum) return { name: '', share: 0, n: 0, sum: 0 }
	return { name: r[0].name, share: r[0].count / sum, n: r.length, sum }
}

// Enough traffic in the panel for a share to carry evidence. The row count
// alone is not enough, because `share` is scale-invariant: counts of [1,1,1]
// give n = 3 and a 0.33 "spread" while proving nothing at all. Most
// distribution polls run at speed 25, where the 10s window holds ~250 events
// for a summed top-5 near 120. The hydration delivery gate can run at the
// default speed 5, where its summed top-5 is nearer 35; a floor of 10 still
// sits comfortably below either live state and far above a degenerate one.
// n >= 3 on top of it tolerates a momentary partial render while still
// excluding the empty panel.
export const populated = (s) => s.n >= 3 && s.sum >= 10
// Midnight Drift holds a majority of the rendered counts.
export const dominant = (s) => populated(s) && s.name === 'Midnight Drift' && s.share > 0.5
// Nobody is close to a majority.
export const spread = (s) => populated(s) && s.share < 0.4
// Distinguishes "rejected for want of data" from "rejected on the share" - a
// poll that fails the population floor must not print a share that reads like
// a passing state.
export const describeShare = (s) => (populated(s) ? `${s.name} @ ${s.share.toFixed(2)}` : `sparse n=${s.n} sum=${s.sum}`)

// The three hot items, as an order-insensitive podium signature.
export const HOT_NAMES = ['Aurora Flux', 'Crimson Loop', 'Echo Garden']
export const HOT_PODIUM = [...HOT_NAMES].sort().join('|')

// Podium membership PLUS the three hot items' combined share of the rendered
// top-5. The bar has to clear the uniform baseline rather than sit at 0.5: the
// coincidence being guarded against is "these three happen to hold the top
// three", and whenever all three DO land in the rendered five their counts are
// already ~60% of its sum (five near-equal order statistics), so a >50% bar
// would wave through the exact false pass it was meant to catch.
//
// Measured, sampling the rendered top-5 twice a second for 45s per bias at
// speed 25, after a full ring turnover:
//   uniform: hot share median 0.21, max 0.615; the podium matched the three
//            hot items in 0 of 88 samples.
//   hot:     hot share min 0.768, median 0.814, max 0.836; 87 of 87 over 0.75.
// So 0.75 sits 0.135 above everything uniform produced and below everything
// hot produced. The margin looks slim against hot's MINIMUM, but the poll
// needs only ONE sample over the bar inside its window, so the statistic that
// governs it is the maximum across several independent ring turnovers.
//
// Carries the same `n` as leaderShare, for the same reason: the empty-panel
// sentinel reads share 0, so any predicate phrased as "the hot share is NOT
// above the bar" is satisfied by a panel with nothing in it.
export async function hotSignal(page, panel) {
	const r = await rows(page, panel)
	const sum = r.reduce((acc, x) => acc + x.count, 0)
	if (!r.length || !sum) return { podium: '', share: 0, n: 0, sum: 0 }
	const hot = r.filter((x) => HOT_NAMES.includes(x.name)).reduce((acc, x) => acc + x.count, 0)
	return { podium: r.slice(0, 3).map((x) => x.name).sort().join('|'), share: hot / sum, n: r.length, sum }
}

// The three hot items hold the podium AND the magnitude to go with it, in a
// panel with enough traffic for that to mean something - see `populated`.
export const hotLed = (s) => populated(s) && s.podium === HOT_PODIUM && s.share > 0.75
export const describeHot = (s) => (populated(s) ? `${s.podium} @ ${s.share.toFixed(2)}` : `sparse n=${s.n} sum=${s.sum}`)
