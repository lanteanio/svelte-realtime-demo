import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/notifications: two tabs forced onto
// DIFFERENT SO_REUSEPORT replicas (instance A vs instance B) against shared
// Redis + Postgres. This tier proves the three halves the single-instance
// suite cannot see:
//   1. live.push routed OVER the cluster connection registry: a send handled
//      on replica A reaches a recipient whose socket lives on replica B, and
//      the recipient's reply value travels back to A - for both ack kinds.
//   2. The scheduled-queue and activity streams fan out across replicas (a
//      Redis-backed HASH + capped LIST + cluster pub/sub).
//   3. The 6-field live.cron is a cluster SINGLETON (leader-gated): an entry
//      scheduled on replica A is drained by whichever replica holds the
//      leader lease and pushed into B's inbox (cross-instance whenever that
//      leader is not B's own replica; the test does not pin the lease, so it
//      asserts only arrival + the 'fired' log, which hold either way).
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

const RUN = `cluster-${Date.now()}`

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/notifications`)
	await waitForWS(page)
}

async function getMyId(page) {
	return await page.getByTestId('my-id').getAttribute('data-user-id')
}

async function selectRecipient(a, bId) {
	// B's presence must fan across the cluster into A's dropdown first.
	const option = a.getByTestId(`recipient-option-${bId}`)
	await expect(option).toBeAttached({ timeout: 15_000 })
	await a.getByTestId('recipient-select').selectOption(bId)
}

test.describe('cluster: /demos/notifications cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('a push handled on replica A reaches B on replica B; Got it routes delivered back to A', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `xrep-${RUN}-ok`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			// B's socket lives on the OTHER replica, so this card can only have
			// arrived via the cluster connection registry (registry.request).
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 12_000 })
			await expect(a.getByTestId('send-button')).toHaveText('Sending...')

			// B replies; the reply value routes back across the cluster to A.
			await inboxCard.getByTestId('inbox-ack-ok').click()
			await expect(a.getByTestId('outcome-kind')).toHaveText('delivered', { timeout: 10_000 })
			await expect(inboxCard).toHaveCount(0)

			// The activity log fans out to both replicas.
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('delivered', { timeout: 10_000 })
			await expect(b.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('delivered', { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('cross-replica reply value: Dismiss on replica B comes back to A as dismissed', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `xrep-${RUN}-dismiss`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 12_000 })
			await inboxCard.getByTestId('inbox-ack-dismiss').click()

			// The 'dismiss' reply value must survive the cross-instance round trip.
			await expect(a.getByTestId('outcome-kind')).toHaveText('dismissed', { timeout: 10_000 })
			await expect(inboxCard).toHaveCount(0)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a schedule on replica A is drained by the cluster-singleton cron and fired into B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// 5s window, matching the single-instance test - the cross-replica
			// tier has higher fan-out latency, so it gets at least as comfortable
			// a window to observe the queued entry before the cron drains it.
			const text = `xrep-${RUN}-sched`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('schedule-input').fill('5')
			await a.getByTestId('send-button').click()
			await expect(a.getByTestId('outcome-kind')).toHaveText('scheduled', { timeout: 5_000 })

			// The queue entry, written to shared Redis on replica A, fans out to
			// B on the other replica.
			const bItem = b.getByTestId('scheduled-item').filter({ hasText: text })
			await expect(bItem).toBeVisible({ timeout: 8_000 })

			// Whichever replica holds the cron leader lease drains the due entry
			// and pushes it to B (cross-instance when the leader is not B's own
			// replica); the queue drops it on A and both replicas' activity logs
			// record a 'fired' event.
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 12_000 })
			await expect(a.getByTestId('scheduled-item').filter({ hasText: text })).toHaveCount(0, { timeout: 5_000 })
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('fired', { timeout: 10_000 })
			await expect(b.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('fired', { timeout: 10_000 })

			// Cleanup: B acks the fired push.
			await inboxCard.getByTestId('inbox-ack-ok').click()
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
