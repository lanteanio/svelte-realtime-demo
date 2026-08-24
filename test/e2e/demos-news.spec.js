import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/news - a live newsroom wiring
// FOUR realtime primitives together: a live.webhook publish bridge
// (HMAC-signed), a 1Hz live.cron view firehose, a live.aggregate with
// three trending windows (sliding 30s / tumbling minute / lifetime), and a
// live.derived stats strip. Drives every interactive element (speed slider,
// headline + summary inputs, publish button) and asserts REAL outcomes: the
// publish button's gating + in-flight guard, the HMAC webhook round-trip
// landing a story with a 'webhook' badge, a freshly-published story climbing
// the trending leaderboard (the editorial loop = cron + aggregate + webhook),
// the speed slider actually pausing/resuming the firehose, and the derived
// strip tracking stories / views / newest headline. Cross-replica behaviour
// (webhook publish + cluster-shared aggregate/derived) lives in the
// .cluster.spec.js sibling.
//
// Stories + counters are GLOBAL cluster-shared Redis state, so each test tags
// its headline with a unique timestamp and filters by it (workers=1 serial;
// per-tier FLUSHDB gives a clean start; the firehose defaults to speed=5).

async function open(page) {
	await page.goto('/demos/news')
	await waitForWS(page)
}

// The speed slider commits onchange; fill() on a range input fires it.
async function setSpeed(page, n) {
	await page.getByTestId('news-speed-input').fill(String(n))
}

// Publish a headline through the webhook form and wait for the success banner.
async function publishStory(page, headline, summary = '') {
	await page.getByTestId('news-headline-input').fill(headline)
	if (summary) await page.getByTestId('news-summary-input').fill(summary)
	await page.getByTestId('news-publish-button').click()
	await expect(page.getByTestId('news-publish-ok')).toBeVisible({ timeout: 8_000 })
}

function totalViews(page) {
	return page.getByTestId('stat-totalViews').textContent()
		.then((t) => Number((t ?? '0').trim()))
}

function totalStories(page) {
	return page.getByTestId('stat-totalStories').textContent()
		.then((t) => Number((t ?? '0').trim()))
}

test.describe('/demos/news', () => {
	test('renders the newsroom: trending panels, stats strip, speed slider, publish form, seed stories', async ({ page }) => {
		await open(page)
		await expect(page.getByTestId('lb-news-last30s')).toBeVisible()
		await expect(page.getByTestId('lb-news-thisMinute')).toBeVisible()
		await expect(page.getByTestId('lb-news-lifetime')).toBeVisible()
		await expect(page.getByTestId('news-stats-strip')).toBeVisible()
		await expect(page.getByTestId('news-speed-input')).toBeVisible()
		await expect(page.getByTestId('news-publish-form')).toBeVisible()
		await expect(page.getByTestId('news-headline-input')).toBeVisible()
		await expect(page.getByTestId('news-publish-button')).toBeVisible()
		// At least one story has hydrated from the stories stream on connect.
		await expect(page.getByTestId('news-story').first()).toBeVisible({ timeout: 10_000 })
	})

	test('publish button gates on headline text', async ({ page }) => {
		await open(page)
		const btn = page.getByTestId('news-publish-button')

		// No headline -> disabled.
		await expect(btn).toBeDisabled()
		// Real headline -> enabled, label is "Publish".
		await page.getByTestId('news-headline-input').fill(`gate-${Date.now()}`)
		await expect(btn).toBeEnabled()
		await expect(btn).toHaveText('Publish')
		// Whitespace-only -> disabled again (client pre-empts the server's
		// `headline required` VALIDATION).
		await page.getByTestId('news-headline-input').fill('   ')
		await expect(btn).toBeDisabled()
		// Real text -> enabled; clearing -> disabled. Summary never gates.
		await page.getByTestId('news-headline-input').fill('back to real')
		await expect(btn).toBeEnabled()
		await page.getByTestId('news-headline-input').fill('')
		await expect(btn).toBeDisabled()
	})

	test('publish is guarded in-flight: the button shows Publishing... and blocks re-submit', async ({ page }) => {
		test.setTimeout(30_000)
		// Delay every server->client WS frame. signPublish is a realtime RPC
		// over the socket, so its reply is delayed and the publish stays
		// in-flight; the button must show the busy state and stay disabled the
		// whole time (no double-submit). The webhook POST is plain HTTP and is
		// not delayed, so once signPublish resolves the round-trip completes.
		const DELAY = 1_500
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => { setTimeout(() => ws.send(m), DELAY) })
		})
		// Gate on hydration/WS (waitForWS resolves ~1.5s later under the frame
		// delay, well inside its 15s wait) so the form's onsubmit handler is
		// wired before the click - a bare goto could native-submit the form.
		await open(page)

		const btn = page.getByTestId('news-publish-button')
		await page.getByTestId('news-headline-input').fill(`inflight-${Date.now()}`)
		await btn.click()

		// The busy state latches synchronously and holds through the delayed
		// signPublish reply.
		await expect(btn).toHaveText('Publishing...')
		await expect(btn).toBeDisabled()
		await page.waitForTimeout(DELAY / 2)
		await expect(btn).toBeDisabled()

		// Once the delayed reply lands and the webhook POST returns, success.
		await expect(page.getByTestId('news-publish-ok')).toBeVisible({ timeout: 8_000 })
		await expect(btn).toHaveText('Publish')
	})

	test('publish round-trips through the HMAC webhook: the story lands with a webhook badge', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		await expect(page.getByTestId('news-story').first()).toBeVisible({ timeout: 10_000 })

		const headline = `Probe headline ${Date.now()}`
		const summary = 'Routed via /api/demos/news/webhook with an HMAC-SHA256 signature.'
		await publishStory(page, headline, summary)

		// The story shows up in the list with its summary...
		const story = page.getByTestId('news-story').filter({ hasText: headline })
		await expect(story).toBeVisible({ timeout: 5_000 })
		await expect(story.getByTestId('news-story-summary')).toHaveText(summary)
		// ...and carries the 'webhook' badge (not 'seed').
		await expect(story.getByText('webhook', { exact: true })).toBeVisible()
		// The inputs reset on success.
		await expect(page.getByTestId('news-headline-input')).toHaveValue('')
		await expect(page.getByTestId('news-summary-input')).toHaveValue('')
	})

	test('a published story climbs the trending leaderboard (cron firehose + windowed aggregate)', async ({ page }) => {
		test.setTimeout(45_000)
		await open(page)
		try {
			// Crank the firehose so the freshly-published story accrues views
			// fast (the firehose biases 50% toward the newest 3 stories).
			await setSpeed(page, 30)

			const headline = `trend-${Date.now()}`
			await publishStory(page, headline)
			await expect(page.getByTestId('news-story-headline').filter({ hasText: headline }))
				.toBeVisible({ timeout: 8_000 })

			// Within a few firehose ticks the new headline appears BY NAME in
			// the sliding-30s leaderboard - proving the whole loop: webhook ->
			// stories list -> firehose pick -> aggregate top-5 -> subscriber.
			await expect(page.getByTestId('lb-news-last30s-name').filter({ hasText: headline }))
				.toBeVisible({ timeout: 20_000 })
		} finally {
			await setSpeed(page, 5)
		}
	})

	test('all three trending windows populate from the firehose', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		// The firehose (default speed=5) picks from the stories in Redis, so
		// every window accumulates counts and publishes rows within a few ticks.
		for (const panel of ['lb-news-last30s', 'lb-news-thisMinute', 'lb-news-lifetime']) {
			await expect(page.getByTestId(`${panel}-rows`)).toBeVisible({ timeout: 15_000 })
			const rows = await page.getByTestId(`${panel}-row`).count()
			expect(rows).toBeGreaterThanOrEqual(1)
			expect(rows).toBeLessThanOrEqual(5)
		}
	})

	test('five trending names remain visible across the 640/768/844 tablet rungs', async ({ page }) => {
		test.setTimeout(45_000)
		await page.setViewportSize({ width: 640, height: 900 })
		await open(page)
		try {
			await setSpeed(page, 50)
			const names = page.getByTestId('lb-news-lifetime-name')
			await expect(names).toHaveCount(5, { timeout: 20_000 })
			for (const width of [640, 768, 844]) {
				await page.setViewportSize({ width, height: 1024 })
				const gridTracks = await page.getByTestId('news-trending-grid').evaluate((element) => (
					getComputedStyle(element).gridTemplateColumns.split(' ').length
				))
				expect(gridTracks).toBe(1)
				const rendered = await names.evaluateAll((elements) => elements.map((element) => ({
					text: element.textContent.trim(),
					width: element.getBoundingClientRect().width
				})))
				expect(new Set(rendered.map((entry) => entry.text)).size).toBe(5)
				for (const entry of rendered) {
					expect(entry.text).not.toBe('')
					expect(entry.width).toBeGreaterThan(100)
				}
			}
		} finally {
			await setSpeed(page, 5)
		}
	})

	test('the derived stats strip tracks stories, views, and the newest headline', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)

		// Seeds -> totalStories >= 6 (derived recomputes on the 1Hz lifetime
		// publish, so it may briefly show 0 before the first tick).
		await expect.poll(() => totalStories(page), { timeout: 12_000 }).toBeGreaterThanOrEqual(6)
		// Views climb above zero at the default firehose speed.
		await expect.poll(() => totalViews(page), { timeout: 12_000 }).toBeGreaterThan(0)

		// Publishing bumps totalStories and sets the newest headline.
		const before = await totalStories(page)
		const headline = `stats-${Date.now()}`
		await publishStory(page, headline)
		await expect.poll(() => totalStories(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 1)
		await expect(page.getByTestId('stat-newestHeadline')).toContainText(headline, { timeout: 10_000 })
	})

	test('the speed slider drives the firehose: 0 pauses new views, raising it resumes them', async ({ page }) => {
		test.setTimeout(45_000)
		await open(page)
		try {
			// Confirm views are flowing.
			await setSpeed(page, 20)
			await expect.poll(() => totalViews(page), { timeout: 12_000 }).toBeGreaterThan(0)

			// Pause the firehose; let the last in-flight tick + derived debounce
			// settle, then snapshot the frozen total.
			await setSpeed(page, 0)
			await page.waitForTimeout(2_500)
			const paused = await totalViews(page)
			// With speed 0 no 'viewed' events fire, so the aggregate stops
			// publishing and the derived total holds flat over the next window.
			await page.waitForTimeout(3_000)
			expect(await totalViews(page)).toBe(paused)

			// Raising the speed resumes the firehose and the total climbs again.
			await setSpeed(page, 25)
			await expect.poll(() => totalViews(page), { timeout: 12_000 }).toBeGreaterThan(paused)
		} finally {
			await setSpeed(page, 5)
		}
	})

	test('the firehose rate is shared state: a change in one browser reaches the other without a reload', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		try {
			const a = await ctxA.newPage()
			const b = await ctxB.newPage()
			await open(a)
			await open(b)

			// Both sides start at the default, so asserting 7 requires B to
			// actually move. Asserting the event RATE instead would not
			// discriminate: the cron reads the value from Redis, so the
			// firehose already changed for everyone. It is the readout that
			// used to disagree until a reload.
			await expect(b.getByTestId('news-speed-input')).toHaveValue('5')
			await setSpeed(a, 7)
			await expect(b.getByTestId('news-speed-input')).toHaveValue('7', { timeout: 10_000 })
			await expect(b.getByTestId('news-speed-label')).toHaveText('7 view events/sec')

			// A second, different change, chosen at the pause edge because its
			// label takes the other branch: one arriving value could be a
			// coincidence, and only this one exercises the zero case.
			await setSpeed(a, 0)
			await expect(b.getByTestId('news-speed-input')).toHaveValue('0', { timeout: 10_000 })
			await expect(b.getByTestId('news-speed-label')).toHaveText('paused')

			// And it travels both ways, not just from whoever loaded first.
			await setSpeed(b, 3)
			await expect(a.getByTestId('news-speed-input')).toHaveValue('3', { timeout: 10_000 })
		} finally {
			const restore = await ctxA.newPage()
			await open(restore)
			await setSpeed(restore, 5)
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('panel title and subtitle separate onto their own lines at narrow rungs', async ({ page }) => {
		await open(page)
		const header = page.getByTestId('lb-news-last30s').locator('h2').first()
		const subtitle = page.getByTestId('lb-news-last30s').locator('h2 + span').first()

		// Wide: both sit on one line, so their vertical extents overlap.
		await page.setViewportSize({ width: 1440, height: 900 })
		await expect.poll(async () => {
			const [a, b] = await Promise.all([header.boundingBox(), subtitle.boundingBox()])
			return a && b ? b.y < a.y + a.height : null
		}).toBe(true)

		// Narrow: the subtitle wraps clear of the title instead of butting
		// against it. Without flex-wrap both are pinned to one line and this
		// assertion fails, which is the regression it exists to catch.
		await page.setViewportSize({ width: 320, height: 720 })
		await expect.poll(async () => {
			const [a, b] = await Promise.all([header.boundingBox(), subtitle.boundingBox()])
			return a && b ? b.y >= a.y + a.height : null
		}).toBe(true)
	})

	test('newest timestamp stays visible while a long headline truncates', async ({ page }) => {
		await open(page)
		const headline = `long-headline-regression-${Date.now()}-${'x'.repeat(30)}`
		await publishStory(page, headline)
		await expect(page.getByTestId('stat-newestHeadline')).toContainText(headline.slice(0, 20), { timeout: 10_000 })

		await page.setViewportSize({ width: 320, height: 720 })
		const time = page.getByTestId('stat-newestTime')
		await expect(time).toBeVisible()
		await expect(time).not.toHaveText('')

		// The headline must be the element that gives way, not the time: the
		// time used to sit inside the truncating flow and vanish first.
		await expect.poll(() => page.getByTestId('stat-newestHeadline').evaluate(
			(element) => element.scrollWidth > element.clientWidth
		)).toBe(true)
		const box = await time.boundingBox()
		expect(box.width, 'timestamp must keep real width at 320').toBeGreaterThan(0)
		expect(box.x + box.width, 'timestamp must stay inside the viewport').toBeLessThanOrEqual(320)
	})

	test('publish form controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			await expectTouchTarget(page.getByTestId('news-headline-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('news-summary-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('news-publish-button'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('news-speed-input'), { minWidth: 0 })
		} finally {
			await context.close()
		}
	})
})
