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
		// A known-open cross-replica coordination gap in enumerable owner rooms
		// (contrast the chat test above, a plain live.room, which passes). Two
		// members join one table from different replicas:
		//   - the enumerable rooms() registry aggregates the count cluster-wide
		//     (both replicas read 2/8), but the presence() sub-stream only
		//     delivers same-replica members (each viewer sees just itself), and
		//   - when the remote member leaves, the registry count is never
		//     decremented (stays 2/8), which over repeated join/leave cycles is
		//     the "member count climbs" leak.
		// Marked test.fail: it flips to a real failure (alerting us to drop the
		// annotation) once the upstream presence relay + purge lands.
		test.fail()
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

	test('per-board presence decrements cross-replica when a member navigates away', async ({ browser }) => {
		// A member on a board (joinBoard -> board:{id} presence) navigates AWAY,
		// firing leaveBoard -> presence.leave with the WS still open. A viewer on
		// another replica must see the board's presence count drop, not linger
		// until the 90s client maxAge. On 2 instances this decrements in ~65ms;
		// this guards that cross-replica leave-diff relay (the reported prod "stuck
		// N here" needs the 4-replica SO_REUSEPORT topology to manifest as a leak).
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const title = `prestest-${Date.now()}`
		// Board presence avatar count from the board page's PresenceBar.
		const boardCount = (page) => page.locator('.avatar-group .avatar').count()
		try {
			// A creates a board and lands on it (joinBoard -> board:{id} presence).
			await a.goto(`${INSTANCE_A}/`)
			await waitForWS(a)
			await a.getByPlaceholder('New board name...').fill(title)
			await a.getByRole('button', { name: 'Create' }).click()
			await a.waitForURL(/\/board\//, { timeout: 15_000 })
			const boardPath = new URL(a.url()).pathname

			// B joins the SAME board on the other replica; A sees both (fan-out ok).
			await b.goto(`${INSTANCE_B}${boardPath}`)
			await waitForWS(b)
			await expect.poll(() => boardCount(a), { message: 'A should see both members', timeout: 15_000 }).toBe(2)

			// B navigates away (leaveBoard fires; WS stays open) - A must decrement.
			await b.goto(`${INSTANCE_B}/`)
			await expect
				.poll(() => boardCount(a), { message: 'A count should decrement when B navigates away', timeout: 10_000 })
				.toBe(1)
		} finally {
			await ctxA.close()
			await ctxB.close()
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
