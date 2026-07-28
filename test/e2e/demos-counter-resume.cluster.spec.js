import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/counter-resume: two tabs forced onto
// DIFFERENT SO_REUSEPORT replicas (instance A vs instance B) against shared
// Redis + Postgres. This tier proves the properties the single-instance suite
// cannot see:
//   1. The 1Hz tick cron is a CLUSTER SINGLETON (configureCron leader) - the
//      global counter advances at ~1/s, NOT ~2/s. A broken leader election
//      would let every replica run the cron and double-count.
//   2. Cross-replica pub/sub fans the tick out, so a subscriber on the replica
//      that is NOT the cron leader still sees the counter advance and converge.
//   3. A Reset RPC handled on replica A broadcasts across replicas to B.
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/counter-resume`)
	await waitForWS(page)
	await expect(page.getByTestId('counter')).toHaveAttribute('data-hydrated', 'true', { timeout: 15_000 })
}

async function counterValue(page) {
	const raw = (await page.getByTestId('counter').textContent()) ?? ''
	return Number(raw.trim())
}

test.describe('cluster: /demos/counter-resume cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('the tick cron is a cluster singleton (~1 tick/s, not 2)', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctx = await browser.newContext({ baseURL: INSTANCE_A })
		const page = await ctx.newPage()
		try {
			await openAt(page, INSTANCE_A)
			await expect.poll(() => counterValue(page), { timeout: 10_000 }).toBeGreaterThan(0)

			const WINDOW_MS = 8_000
			const start = await counterValue(page)
			await page.waitForTimeout(WINDOW_MS)
			const end = await counterValue(page)
			const delta = end - start
			console.log(`[counter-resume singleton diag] delta=${delta} over ${WINDOW_MS}ms (start=${start} end=${end}) -- 1x cron ~= 8, 2x ~= 16`)

			// One leader across the cluster ticking at 1Hz advances ~8 in 8s. If
			// leader election were broken and BOTH replicas ran the cron the global
			// INCR would advance ~16. The window brackets the real 1x rate: the >=6
			// lower bound rejects a half-rate/stalled cron (~4 or less) as well as a
			// dead one, and the <=12 upper bound is the 1x/2x discriminator.
			expect(delta, `counter advanced by ${delta} over ${WINDOW_MS}ms (start=${start} end=${end})`).toBeGreaterThanOrEqual(6)
			expect(delta, `counter advanced by ${delta} over ${WINDOW_MS}ms (start=${start} end=${end})`).toBeLessThanOrEqual(12)
		} finally {
			await ctx.close()
		}
	})

	test('a subscriber on replica B sees the counter advance and converge with replica A', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// B is very likely on the non-leader replica; the cross-replica pub/sub
			// relay must still deliver ticks, so B's counter advances...
			const startB = await counterValue(b)
			await expect.poll(() => counterValue(b), { timeout: 8_000 }).toBeGreaterThanOrEqual(startB + 2)

			// ...and both replicas agree on the shared value within one in-flight tick.
			await expect
				.poll(async () => Math.abs((await counterValue(a)) - (await counterValue(b))), { timeout: 12_000 })
				.toBeLessThanOrEqual(1)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a Reset on replica A resets the counter on replica B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			await expect.poll(() => counterValue(a), { timeout: 15_000 }).toBeGreaterThan(6)
			const beforeB = await counterValue(b)

			await confirmAndClick(a.getByTestId('reset-button'))

			// The reset RPC ran on replica A; its 'set' 0 broadcast must cross the
			// cluster and drop B's counter (B never touched Reset).
			await expect
				.poll(() => counterValue(b), { timeout: 10_000 })
				.toBeLessThan(beforeB - 3)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
