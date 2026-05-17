/**
 * Reproduce two cluster-routing bugs locally:
 *
 * 1. /demos/chat/{room} - the per-room presence list only includes users
 *    on the same replica as the viewer (live.room({ presence }) uses an
 *    in-process _presenceRef Map).
 *
 * 2. /demos/auctions - createAuction's per-bidder live.push only reaches
 *    bidders co-located on the seller's replica (cluster registry route
 *    failing for some bidders).
 *
 * Run with two app instances on the same Redis/Postgres:
 *   PORT=3091 ORIGIN=http://localhost:3091 node --env-file=.env build &
 *   PORT=3092 ORIGIN=http://localhost:3092 node --env-file=.env build &
 *   BASE_URL=http://localhost:3091 INSTANCE_B=http://localhost:3092 \
 *     npx playwright test e2e/cluster-bugs-probe.spec.js
 */

import { test, expect } from '@playwright/test'

const INSTANCE_A = process.env.BASE_URL || 'http://localhost:3091'
const INSTANCE_B = process.env.INSTANCE_B || 'http://localhost:3092'

test.describe.configure({ mode: 'serial' })

test.describe('cluster bugs: presence + push', () => {
	test('chat presence: each viewer should see all subscribers regardless of replica', async ({ browser }) => {
		// One user pinned to A, one to A, one to B. Mirrors the bug report.
		const ctxA1 = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxA2 = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB1 = await browser.newContext({ baseURL: INSTANCE_B })
		const a1 = await ctxA1.newPage()
		const a2 = await ctxA2.newPage()
		const b1 = await ctxB1.newPage()
		try {
			await a1.goto(`${INSTANCE_A}/demos/chat/general`)
			await a2.goto(`${INSTANCE_A}/demos/chat/general`)
			await b1.goto(`${INSTANCE_B}/demos/chat/general`)

			// Wait for each page's online list to populate at least once.
			for (const p of [a1, a2, b1]) {
				await expect(p.locator('text=/Online/i').first()).toBeVisible({ timeout: 10_000 })
			}
			// Give cluster bus fan-out a generous window. Presence joins from
			// other replicas need a Redis pub/sub round-trip to reach the local
			// :presence stream subscribers.
			await a1.waitForTimeout(5000)

			async function rosterCount(page) {
				// Online list: <h2>Online</h2> followed by a <ul> of <li class="badge">.
				const onlineHeader = page.locator('h2.card-title', { hasText: 'Online' }).first()
				const list = onlineHeader.locator('xpath=following-sibling::ul[1]')
				return await list.locator('li.badge').count()
			}

			const a1Count = await rosterCount(a1)
			const a2Count = await rosterCount(a2)
			const b1Count = await rosterCount(b1)

			console.log(`[ROSTER] a1=${a1Count} a2=${a2Count} b1=${b1Count}`)
			// Expected: all 3 see all 3 users in the roster.
			// Pre-fix bug: a1 and a2 see each other (2), b1 sees only itself (1).
			expect(a1Count, 'a1 should see all 3').toBe(3)
			expect(a2Count, 'a2 should see all 3').toBe(3)
			expect(b1Count, 'b1 should see all 3').toBe(3)
		} finally {
			await ctxA1.close()
			await ctxA2.close()
			await ctxB1.close()
		}
	})

	test('auctions live.push: seller on A pushes to bidders on A and B', async ({ browser }) => {
		const seller = await browser.newContext({ baseURL: INSTANCE_A })
		const bidderSameReplica = await browser.newContext({ baseURL: INSTANCE_A })
		const bidderOtherReplica = await browser.newContext({ baseURL: INSTANCE_B })
		const s = await seller.newPage()
		const ba = await bidderSameReplica.newPage()
		const bb = await bidderOtherReplica.newPage()
		try {
			await s.goto(`${INSTANCE_A}/demos/auctions`)
			await ba.goto(`${INSTANCE_A}/demos/auctions`)
			await bb.goto(`${INSTANCE_B}/demos/auctions`)

			// Wait for seller's listing form to show BOTH bidders. If presence
			// is per-replica, this poll will fail after 15s with "1 bidder"
			// instead of "2 bidders" - the smoking gun for the presence bug.
			await expect.poll(
				async () => (await s.getByTestId('list-submit').textContent()) ?? '',
				{ timeout: 15_000, message: 'seller should see both cross-replica bidders in presence' }
			).toMatch(/2 bidders/)

			const item = `clusterprobe-${Date.now()}`
			await s.getByTestId('list-item-input').fill(item)
			await s.getByTestId('list-start-input').fill('10')
			await s.getByTestId('list-reserve-input').fill('15')
			await s.getByTestId('list-duration-input').fill('6')
			await s.getByTestId('list-submit').click()

			const baCard = ba.getByTestId('inbox-card').filter({ hasText: item })
			const bbCard = bb.getByTestId('inbox-card').filter({ hasText: item })

			// Pre-fix bug: only the same-replica bidder sees the card; the
			// other-replica bidder never receives the push.
			const baVisible = await baCard.isVisible({ timeout: 8_000 }).catch(() => false)
			const bbVisible = await bbCard.isVisible({ timeout: 8_000 }).catch(() => false)
			console.log(`[PUSH] sameReplica=${baVisible} otherReplica=${bbVisible}`)
			expect(baVisible, 'bidder on same replica as seller should see push').toBe(true)
			expect(bbVisible, 'bidder on other replica should also see push').toBe(true)
		} finally {
			await seller.close()
			await bidderSameReplica.close()
			await bidderOtherReplica.close()
		}
	})
})
