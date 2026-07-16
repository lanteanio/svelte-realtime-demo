import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/counter-resume - a server-driven
// 1Hz counter (cluster-singleton cron -> Redis INCR) streamed with merge:'set'
// and replay:true. Drives the only interactive control (Reset) and the network
// path a real user exercises (DevTools -> Offline -> Online) and asserts REAL
// outcomes: the counter ticks live, freezes while offline, and on reconnect the
// RESUME path catches up to the latest value in a single frame and surfaces the
// SIZE of the gap it filled via a "+N replayed" badge. NOTE: merge:'set'
// coalesces the offline gap into one frame (the latest value), so the ledger
// does NOT gain a row per skipped tick - it gains one row carrying the gap
// count. (An earlier draft wrongly asserted individual intermediate rows; the
// run-1 diagnostic proved the coalescing. See the resume test.)
// Cross-replica behaviour lives in the .cluster.spec.js sibling.
//
// The counter is a single GLOBAL Redis key shared by every tab, so assertions
// are delta-based (advances / drops relative to a captured value), never on an
// absolute count. Tests run serially (workers=1) so the shared key is stable
// within a test.

async function open(page) {
	await page.goto('/demos/counter-resume')
	await waitForWS(page)
	// Gate on a real stream frame, not the pre-hydration '...' fallback.
	await expect(page.getByTestId('counter')).toHaveAttribute('data-hydrated', 'true', { timeout: 15_000 })
}

async function counterValue(page) {
	const raw = (await page.getByTestId('counter').textContent()) ?? ''
	return Number(raw.trim())
}

async function ledgerValues(page) {
	return page
		.locator('[data-testid="ledger-row"]')
		.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))))
}

test.describe('/demos/counter-resume', () => {
	test('hydrates and ticks live while connected', async ({ page }) => {
		test.setTimeout(20_000)
		await open(page)
		await expect(page.getByTestId('ws-status')).toHaveText('open')

		const start = await counterValue(page)
		expect(Number.isFinite(start)).toBe(true)
		// A 1Hz server tick must advance the visible counter by at least 2. The poll
		// resolves as soon as that holds (~2s at 1Hz); 8s is the ceiling, not the target.
		await expect
			.poll(() => counterValue(page), { timeout: 8_000 })
			.toBeGreaterThanOrEqual(start + 2)
	})

	test('the ledger records each tick, newest-first, tracking the live counter', async ({ page }) => {
		test.setTimeout(20_000)
		await open(page)
		await expect
			.poll(async () => (await ledgerValues(page)).length, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(3)

		const vals = await ledgerValues(page)
		// Newest is prepended, and the counter is monotonic, so the ledger must be
		// non-increasing top-to-bottom.
		for (let i = 1; i < vals.length; i++) {
			expect(vals[i]).toBeLessThanOrEqual(vals[i - 1])
		}
		// The newest ledger row tracks the live counter (within one in-flight tick).
		const top = vals[0]
		const cur = await counterValue(page)
		expect(Math.abs(top - cur)).toBeLessThanOrEqual(1)
	})

	test('Reset drops the counter toward zero and clears stale ledger rows', async ({ page }) => {
		test.setTimeout(40_000)
		await open(page)
		// Let the counter climb to a clearly non-trivial value first.
		await expect.poll(() => counterValue(page), { timeout: 15_000 }).toBeGreaterThan(6)
		const before = await counterValue(page)

		await page.getByTestId('reset-button').click()

		// Server sets the key to 0 and publishes 'set' 0; the visible counter must
		// fall well below its pre-reset value (a real reset, not a stall).
		await expect
			.poll(() => counterValue(page), { timeout: 8_000 })
			.toBeLessThan(before - 3)
		const low = await counterValue(page)

		// The client wiped the ledger on reset, then fresh ticks refill it. Poll
		// until at least one post-reset row has landed (the ledger is momentarily
		// empty between the wipe and the next tick) so .every() below is not
		// vacuously true, then assert no pre-reset (large) row survived.
		await expect.poll(async () => (await ledgerValues(page)).length, { timeout: 8_000 }).toBeGreaterThan(0)
		const vals = await ledgerValues(page)
		expect(vals.every((v) => v < before)).toBe(true)

		// Ticking resumes after the reset (the cron keeps firing).
		await expect.poll(() => counterValue(page), { timeout: 8_000 }).toBeGreaterThan(low)
	})

	test('offline freezes the counter, then reconnect catches up and marks the filled gap', async ({ page, context }) => {
		test.setTimeout(60_000)
		await open(page)
		await expect.poll(() => counterValue(page), { timeout: 10_000 }).toBeGreaterThan(1)

		// --- go offline ---
		await context.setOffline(true)
		// The layout status leaves 'open' (the socket is dead) and the counter dims.
		await expect(page.getByTestId('ws-status')).not.toHaveText('open', { timeout: 15_000 })
		await expect(page.getByTestId('counter')).toHaveClass(/opacity-50/)
		// Let any in-flight frame settle, then capture the frozen value.
		await page.waitForTimeout(300)
		const frozen = await counterValue(page)

		const OFFLINE_MS = 8_000
		await page.waitForTimeout(OFFLINE_MS)
		// No events can arrive while offline: the counter is frozen.
		expect(await counterValue(page)).toBe(frozen)

		// --- back online ---
		await context.setOffline(false)
		await waitForWS(page) // status returns to 'open'
		// The counter catches up past the frozen value (~1 tick/s during the gap).
		await expect
			.poll(() => counterValue(page), { timeout: 20_000 })
			.toBeGreaterThanOrEqual(frozen + 4)
		const final = await counterValue(page)

		// RESUME PROOF (honest to merge:'set'): reconnect does NOT reload the page
		// (the ledger keeps its pre-offline rows) and it does NOT deliver each
		// skipped tick as its own row - merge:'set' coalesces the whole offline
		// gap into a single frame carrying the latest value. What the resume path
		// DOES surface in the UI is the SIZE of the gap it filled: the newest
		// ledger row is tagged with a "+N replayed" badge where N is the number of
		// ticks skipped while offline. We assert a MULTI-tick gap badge, matching
		// the offline window. That badge is a client-side value delta, so on its
		// OWN it CANNOT distinguish coalesced-resume from a value-identical refetch;
		// this test therefore proves catch-up + gap accounting, not resume-vs-
		// refetch. (Empirically there is no client-visible wire artifact to assert
		// on either: capturing every inbound frame across the reconnect socket for
		// the substring "__replay" yields ZERO matches - the client receives only
		// the coalesced latest value on the normal topic. Run diag confirmed the
		// coalescing: frozen=2 final=10 maxGap=7 badge '+7 replayed'.)
		const badges = await page.locator('[data-testid="gap-badge"]').allTextContents()
		const gaps = badges.map((t) => Number((t.match(/\+(\d+)/) || [])[1] || 0))
		const maxGap = Math.max(0, ...gaps)
		const vals = await ledgerValues(page)
		console.log(
			`[counter-resume resume diag] frozen=${frozen} final=${final} maxGap=${maxGap} badges=${JSON.stringify(badges)} ledger=${JSON.stringify(vals)}`
		)
		expect(
			maxGap,
			`expected a multi-tick "+N replayed" gap badge after a ${OFFLINE_MS}ms offline window; frozen=${frozen} final=${final} badges=${JSON.stringify(badges)} ledger=${JSON.stringify(vals)}`
		).toBeGreaterThanOrEqual(4)
	})

	test('two tabs converge on the same counter (single-instance broadcast)', async ({ browser }) => {
		test.setTimeout(30_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			// A convergence check ALONE is a false positive: both tabs hydrate to the
			// SAME global Redis value, so abs(a-b)<=1 already holds at t=0 even if the
			// live broadcast to tab B is dead. First prove B receives live ticks (its
			// own counter advances on its own socket)...
			const startB = await counterValue(b)
			await expect.poll(() => counterValue(b), { timeout: 12_000 }).toBeGreaterThanOrEqual(startB + 2)
			// ...THEN prove both tabs, fed by the same broadcast, stay in lockstep
			// within a single in-flight tick.
			await expect
				.poll(async () => Math.abs((await counterValue(a)) - (await counterValue(b))), {
					timeout: 12_000,
				})
				.toBeLessThanOrEqual(1)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a Reset in one tab resets the counter in another tab', async ({ browser }) => {
		test.setTimeout(40_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			await expect.poll(() => counterValue(a), { timeout: 15_000 }).toBeGreaterThan(6)
			const beforeB = await counterValue(b)

			await a.getByTestId('reset-button').click()

			// Tab B never touched Reset; its counter falls only because the server
			// broadcast the 'set' 0 to every subscriber.
			await expect
				.poll(() => counterValue(b), { timeout: 8_000 })
				.toBeLessThan(beforeB - 3)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
