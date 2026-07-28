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
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

// Requires two distinct instances; see the matching guard in
// cluster-probe.spec.js. Skip rather than ERR_CONNECTION_REFUSED when the
// suite runs against a single-URL deploy.
test.skip(
	!process.env.INSTANCE_B,
	'cluster-bugs-probe requires INSTANCE_B set (two local instances against shared Redis/Postgres)'
)

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
			async function rosterCount(page) {
				// Online list: <h2>Online</h2> followed by a <ul> of <li class="badge">.
				const onlineHeader = page.locator('h2.card-title', { hasText: 'Online' }).first()
				const list = onlineHeader.locator('xpath=following-sibling::ul[1]')
				return await list.locator('li.badge').count()
			}

			// Presence joins from another replica need a Redis pub/sub round-trip
			// to reach the local :presence subscribers, so poll each roster to
			// converge on all 3 rather than sampling once after a fixed wait - the
			// fixed-wait single read raced the cross-replica delta.
			// Pre-fix bug this guards against: a1/a2 see each other (2), b1 sees
			// only itself (1).
			for (const [page, label] of [[a1, 'a1'], [a2, 'a2'], [b1, 'b1']]) {
				await expect
					.poll(() => rosterCount(page), { message: `${label} should see all 3`, timeout: 15_000 })
					.toBe(3)
			}
		} finally {
			await ctxA1.close()
			await ctxA2.close()
			await ctxB1.close()
		}
	})

	test('lobbies presence + room count stay consistent across replicas', async ({ browser }) => {
		// Regression for RT-391/RT-417: enumerable owner-room presence must
		// converge across replicas, and a live-socket leave must run realtime's
		// managed-topic drain so the shared room count decrements immediately.
		const table = String(100000 + Math.floor((Date.now() % 800000)))
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()

		const rosterCount = (page) => page.getByTestId('lob-presence').locator('li.badge').count()
		const roomCountNum = async (page) => {
			const el = page.getByTestId('lob-room-count').first()
			if (!(await el.count())) return null
			const m = ((await el.textContent()) ?? '').match(/(\d+)\s*\//)
			return m ? Number(m[1]) : null
		}

		try {
			await a.goto(`${INSTANCE_A}/demos/lobbies`)
			await b.goto(`${INSTANCE_B}/demos/lobbies`)
			// Gate on WS-connected so the app is hydrated before we drive the
			// form; interacting pre-hydration drops the bound input value.
			await waitForWS(a)
			await waitForWS(b)

			// Both join the same table (A first so it holds the room open).
			for (const page of [a, b]) {
				await page.getByTestId('lob-new-id').fill(table)
				await page.getByTestId('lob-create').click()
				await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${table}`, { timeout: 10_000 })
			}

			// Cross-replica presence fan-out: A must see both members.
			await expect
				.poll(() => rosterCount(a), { message: 'A should see both members', timeout: 15_000 })
				.toBe(2)

			// Cross-replica leave purge: when B leaves, A's room count decrements.
			await b.getByTestId('lob-leave').click()
			await expect
				.poll(() => roomCountNum(a), { message: 'A room count should decrement when B leaves', timeout: 15_000 })
				.toBe(1)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('board-list observers do not inflate presence and member leave decrements cross-replica', async ({ browser }) => {
		// A member on a board (joinBoard -> board:{id} presence) navigates AWAY,
		// firing leaveBoard -> presence.leave with the WS still open. A BoardCard
		// observer on another replica must not become a member during its snapshot
		// authorization check, and must see the real count drop without waiting for
		// the 90s client maxAge. The pre-fix public deployment reports three members
		// for the two board participants plus this observer and sticks at "1 here".
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const ctxC = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const c = await ctxC.newPage()
		const title = `prestest-${Date.now()}`
		// Board presence avatar count from the board page's PresenceBar.
		const boardCount = (page) => page.locator('.avatar-group .avatar').count()
		const boardCard = (page) => page.locator('a.card', { hasText: title })
		const globalCount = async (page) => {
			const text = await page.locator('.navbar-end').getByText(/^\d+ online$/).textContent()
			return Number(text?.match(/^\d+/)?.[0])
		}
		try {
			// A creates a board and lands on it (joinBoard -> board:{id} presence).
			await a.goto(`${INSTANCE_A}/`)
			await waitForWS(a)
			await a.getByPlaceholder('New board name...').fill(title)
			await a.getByRole('button', { name: 'Create' }).click()
			await a.waitForURL(/\/board\//, { timeout: 15_000 })
			const boardPath = new URL(a.url()).pathname

			// C stays on the home page for the whole lifecycle. Its BoardCard
			// store is mounted BEFORE either leave, exactly matching the reported
			// stale board-list observer and avoiding a separate late-subscription
			// snapshot question.
			await c.goto(`${INSTANCE_B}/`)
			await waitForWS(c)
			await expect(boardCard(c)).toBeVisible()
			// Do not require a late-subscription snapshot here. That is a separate
			// attach-path question; the next JOIN is the included-side gate for
			// this leave test and must bring the mounted observer to the full set.

			// B joins the SAME board on the other replica; both the board page and
			// the already-mounted home card see the two-member fan-out.
			await b.goto(`${INSTANCE_B}${boardPath}`)
			await waitForWS(b)
			await expect.poll(() => boardCount(a), { message: 'A should see both members', timeout: 15_000 }).toBe(2)
			await expect.poll(async () => boardCard(c).locator('.badge-primary').textContent().catch(() => null), {
				message: 'mounted board card should see both members before either leave',
				timeout: 15_000
			}).toBe('2 here')
			await expect.poll(() => globalCount(a), { message: 'global presence should include all three test users', timeout: 15_000 })
				.toBeGreaterThanOrEqual(3)
			const globalWithAllContexts = await globalCount(a)

			// B navigates away (leaveBoard fires; WS stays open). A's board-page
			// roster and C's mounted home-card badge must both decrement, while global
			// presence correctly still includes B's open socket.
			await b.locator('a[href="/"]').first().click()
			await b.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
			await expect
				.poll(() => boardCount(a), { message: 'A count should decrement when B navigates away', timeout: 10_000 })
				.toBe(1)
			await expect(boardCard(c).getByText('1 here', { exact: true })).toBeVisible({ timeout: 10_000 })
			await expect.poll(() => globalCount(a), {
				message: 'client-side navigation should keep B in global presence',
				timeout: 10_000
			}).toBe(globalWithAllContexts)

			// Closing B now exercises the separate WS-close cleanup used by the
			// global navbar counter. Compare a delta rather than an absolute count
			// so the same assertion is valid on a live domain with other visitors.
			await ctxB.close()
			await expect.poll(() => globalCount(a), {
				message: 'global online count should decrement when B closes',
				timeout: 15_000
			}).toBe(globalWithAllContexts - 1)

			// Finally A leaves the board without closing its socket. The board is
			// unique to this test, so its home card must lose the final badge
			// rather than lingering as the reported "1 here".
			await a.locator('a[href="/"]').first().click()
			await a.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
			await expect(boardCard(c).getByText(/^\d+ here$/)).toHaveCount(0, { timeout: 10_000 })
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close(), ctxC.close()])
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

			// Wait for seller's listing form to see at least 2 bidders.
			// The pre-fix bug surfaced as 1 bidder (the same-replica bidder
			// only); the post-fix shape is >= 2 (cross-replica presence
			// fan-out succeeds). Parallel test workers may contribute extra
			// identities so we assert "at least 2" rather than exactly 2.
			await expect.poll(
				async () => {
					const text = (await s.getByTestId('list-submit').textContent()) ?? ''
					const m = text.match(/(\d+)\s+bidder/)
					return m ? Number(m[1]) : 0
				},
				{ timeout: 15_000, message: 'seller should see both cross-replica bidders in presence' }
			).toBeGreaterThanOrEqual(2)
			// Make sure both bidders' WS + onPush handlers are ready before
			// the seller submits, so the per-bidder `live.push` does not
			// race the registry / handler installation.
			await expect(ba.getByTestId('push-ready')).toBeAttached({ timeout: 10_000 })
			await expect(bb.getByTestId('push-ready')).toBeAttached({ timeout: 10_000 })

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
