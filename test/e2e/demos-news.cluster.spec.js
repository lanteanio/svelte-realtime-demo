import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/news: two tabs forced onto DIFFERENT
// SO_REUSEPORT replicas (instance A vs instance B) against shared Redis +
// Postgres. This tier proves the halves the single-instance suite cannot see:
//   1. A story published through the webhook bridge on replica A fans out over
//      the cluster bus into B's already-subscribed stories list, and B's
//      derived stats strip (cluster-shared Redis) reflects it.
//   2. The firehose is a cluster SINGLETON (leader-gated cron), and its event
//      stream crosses the cluster bus. Aggregate windows remain per-replica
//      process memory, but B folds that shared ordered stream into B's own
//      leaderboard, so a story published on A can climb on B without B
//      touching it. This suite deliberately makes no cross-replica count-
//      equality claim.
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

const RUN = `cluster-${Date.now()}`

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/news`)
	await waitForWS(page)
}

async function setSpeed(page, n) {
	await page.getByTestId('news-speed-input').fill(String(n))
}

async function publishStory(page, headline) {
	await page.getByTestId('news-headline-input').fill(headline)
	await page.getByTestId('news-publish-button').click()
	await expect(page.getByTestId('news-publish-ok')).toBeVisible({ timeout: 8_000 })
}

function totalStories(page) {
	return page.getByTestId('stat-totalStories').textContent()
		.then((t) => Number((t ?? '0').trim()))
}

test.describe('cluster: /demos/news cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('a webhook publish on replica A fans out to B\'s stories list and derived stats', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			// B is already subscribed before the publish, and its stats reflect
			// the shared story count.
			await expect(b.getByTestId('news-story').first()).toBeVisible({ timeout: 12_000 })
			// Wait for B's derived stats to hydrate to the seeded baseline before
			// snapshotting, so the +1 delta below actually exercises the increment
			// (not a trivial pass against the stat's $state init of 0).
			await expect.poll(() => totalStories(b), { timeout: 12_000 }).toBeGreaterThanOrEqual(6)
			const beforeB = await totalStories(b)

			// A publishes through instance A's webhook endpoint.
			const headline = `xrep-${RUN}-fanout`
			await publishStory(a, headline)

			// The 'created' event fans across the cluster bus into B's live
			// stories list - B took no action.
			await expect(b.getByTestId('news-story').filter({ hasText: headline }))
				.toBeVisible({ timeout: 12_000 })
			// And B's derived stats strip (cluster-shared Redis) ticks up.
			await expect.poll(() => totalStories(b), { timeout: 12_000 }).toBeGreaterThanOrEqual(beforeB + 1)
			await expect(b.getByTestId('stat-newestHeadline')).toContainText(headline, { timeout: 12_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('a story published on A climbs the trending leaderboard rendered on B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			try {
				// Crank the shared firehose rate (SPEED_KEY is cluster-shared, so
				// whichever replica holds the cron leader lease emits faster).
				await setSpeed(a, 30)

				const headline = `xrep-${RUN}-trend`
				await publishStory(a, headline)

				// The story only exists because A published it. The cluster bus
				// delivers the ordered firehose events to B, whose per-replica
				// aggregate then puts the headline in B's sliding-30s leaderboard.
				await expect(b.getByTestId('lb-news-last30s-name').filter({ hasText: headline }))
					.toBeVisible({ timeout: 25_000 })
			} finally {
				await setSpeed(a, 5)
			}
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
