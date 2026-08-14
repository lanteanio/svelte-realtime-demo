import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

const TICK_CAP = 30
const TARGET_HOST = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000').hostname
const REMOTE_TARGET = !['localhost', '127.0.0.1', '[::1]'].includes(TARGET_HOST)

async function openClusterCron(page) {
	await page.goto('/demos/cluster-cron')
	await waitForWS(page)
	await expect.poll(
		async () => (await page.getByTestId('self-instance-id').textContent())?.trim(),
		{ timeout: 10_000 }
	).toMatch(/^[0-9a-f]{16}$/)
}

async function tickSeqs(page) {
	return page.getByTestId('tick-seq').allTextContents().then((values) => (
		values.map((value) => Number(value.replace('#', '').trim()))
	))
}

function expectContinuousNewestFirst(seqs) {
	expect(seqs.length).toBeGreaterThan(0)
	expect(new Set(seqs).size).toBe(seqs.length)
	for (let index = 1; index < seqs.length; index++) {
		expect(seqs[index - 1] - seqs[index]).toBe(1)
	}
}

// Opacity composites down the tree, so an element's own computed value says
// nothing about how it actually renders inside a dimmed ancestor. The aside
// that used to hold the only jobs pointer is opacity-50; the link inside it
// reads 1 on its own and 0.5 in the frame. Multiply the chain to measure what
// the visitor sees.
function pointerMetrics(locator) {
	return locator.evaluate((el) => {
		let opacity = 1
		for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
			const own = Number.parseFloat(getComputedStyle(node).opacity)
			if (Number.isFinite(own)) opacity *= own
		}
		const rect = el.getBoundingClientRect()
		return {
			opacity,
			fontSize: Number.parseFloat(getComputedStyle(el).fontSize),
			width: rect.width,
			height: rect.height
		}
	})
}

// Computed colours arrive in whatever space the theme authored them (daisyUI
// emits oklch), so painting one pixel is the only parser that handles every
// notation. Alpha is the load-bearing field: a solid surface reports 1, a
// `/10` tint reports 0.1 without ever compositing against its backdrop.
function paintedColor(locator, property) {
	return locator.evaluate((el, prop) => {
		const canvas = document.createElement('canvas')
		canvas.width = 1
		canvas.height = 1
		const ctx = canvas.getContext('2d')
		const raw = getComputedStyle(el)[prop]
		ctx.clearRect(0, 0, 1, 1)
		ctx.fillStyle = raw
		ctx.fillRect(0, 0, 1, 1)
		const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
		return { raw, r, g, b, alpha: a / 255, chroma: (Math.max(r, g, b) - Math.min(r, g, b)) / 255 }
	}, property)
}

function metricSum(body, name, labels = () => true) {
	let total = 0
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith(name)) continue
		const match = line.match(new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`))
		if (match && labels(match[1] ?? '')) total += Number(match[2])
	}
	return total
}

async function scrapeMetrics(request) {
	const token = process.env.METRICS_SCRAPE_TOKEN
	const response = await request.get('/metrics', {
		headers: token ? { 'x-scrape-token': token } : {}
	})
	return {
		status: response.status(),
		contentType: response.headers()['content-type'] ?? '',
		body: await response.text()
	}
}

test.describe('/demos/cluster-cron', () => {
	test('renders and hydrates every observability panel with real leader metadata', async ({ page }) => {
		await openClusterCron(page)

		await expect(page.getByRole('heading', { name: 'Cluster cron: one leader, one tick' })).toBeVisible()
		for (const id of [
			'cluster-cron-self-panel',
			'cluster-cron-ticks',
			'cluster-cron-instances',
			'cluster-cron-usage',
			'cluster-cron-instructions'
		]) {
			await expect(page.getByTestId(id)).toBeVisible()
		}

		await expect(page.getByTestId('lease-key')).not.toHaveText('...')
		await expect(page.getByTestId('lease-key')).toContainText('leader')
		// The usage panel must show the application-side wiring, not just name it.
		await expect(page.getByTestId('cluster-cron-usage')).toContainText('createLeader')
		await expect(page.getByTestId('cluster-cron-usage')).toContainText('configureCron')
		await expect(page.getByTestId('cluster-cron-usage')).toContainText('live.cron')
		await expect(page.getByTestId('self-leader-status')).toHaveText(/leader|follower/)
		await expect(page.getByText(`cap ${TICK_CAP}`, { exact: true })).toBeVisible()
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_acquired_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_renewals_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('leader_lost_total')
		await expect(page.getByTestId('cluster-cron-instructions')).toContainText('svelte_realtime_cron_total')
	})

	test('tick log, current leader, and instance roster agree on real newest-first data', async ({ page }) => {
		await openClusterCron(page)
		await expect(page.getByTestId('cluster-cron-tick-row').nth(2)).toBeVisible({ timeout: 10_000 })

		const rows = page.getByTestId('cluster-cron-tick-row')
		const latestLeader = await rows.first().getAttribute('data-instance-id')
		expect(latestLeader).toMatch(/^[0-9a-f]{16}$/)
		await expect(page.getByTestId('current-leader-id')).toHaveText(`${latestLeader.slice(0, 8)}...`)
		// Single instance: the leader is necessarily this worker, so the cell
		// must say so itself rather than leaving the visitor to prefix-match
		// hex ids across two cells.
		await expect(page.getByTestId('current-leader-self')).toBeVisible()
		// Ownership legend is stated once above the log, not on every row.
		await expect(page.getByTestId('tick-legend')).toBeVisible()
		await expect(page.getByTestId('tick-time').first()).not.toHaveText('')
		await expect(page.getByTestId('tick-instance-id').first()).toHaveText(`${latestLeader.slice(0, 8)}...`)

		expectContinuousNewestFirst(await tickSeqs(page))
		await expect(page.getByTestId('instance-leader-badge')).toHaveCount(1)
		expect(await page.getByTestId('cluster-cron-instance-row').count()).toBeGreaterThanOrEqual(1)
	})

	test('the only page drill-down navigates to durable jobs and back to a live ticking view', async ({ page }) => {
		await openClusterCron(page)
		const before = (await tickSeqs(page))[0] ?? 0

		// The prominent pointer in the takeover card is the drill-down the page
		// offers; the quiet aside link is a footnote and must not be the only
		// route out. Clicking the aside link here is what let the prominent one
		// be deleted with every test still green.
		await expect(page.getByRole('link', { name: '/demos/jobs', exact: true })).toBeVisible()
		await page.getByTestId('jobs-pointer').click()
		await expect(page).toHaveURL(/\/demos\/jobs$/)
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

		await page.goBack()
		await expect(page).toHaveURL(/\/demos\/cluster-cron$/)
		await waitForWS(page)
		await expect.poll(async () => (await tickSeqs(page))[0] ?? 0, { timeout: 10_000 }).toBeGreaterThan(before)
	})

	test('the durable-jobs pointer renders at full opacity and body size on phone and desktop', async ({ page }) => {
		for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
			await page.setViewportSize(viewport)
			await openClusterCron(page)

			const pointer = page.getByTestId('jobs-pointer')
			await expect(pointer).toBeVisible()
			const prominent = await pointerMetrics(pointer)
			const footnote = await pointerMetrics(page.getByRole('link', { name: '/demos/jobs', exact: true }))

			// The instrument has to be able to report a dim element, or "1" below
			// proves nothing. The aside link is the known-dimmed control on the
			// same page: if the chain walk were broken both would read 1.
			expect(footnote.opacity, `aside link opacity at ${viewport.width}px`).toBeLessThan(1)
			expect(prominent.opacity, `jobs-pointer opacity at ${viewport.width}px`).toBe(1)

			// A normal-size line: body text, not the metadata size. The
			// footnote being the smallest target on
			// the page is already handled globally by the demos-layout
			// rule that lifts every closing aside to 0.875rem, so size parity
			// here is correct and only the floor is worth pinning.
			expect(prominent.fontSize, `jobs-pointer font-size at ${viewport.width}px`).toBeGreaterThanOrEqual(14)
			expect(prominent.width).toBeGreaterThan(0)
			expect(prominent.height).toBeGreaterThan(0)

			// Placement is the other half of "repeat the pointer under the
			// takeover card": a pointer that drifts back into the closing aside
			// inherits its dimming again and stops being the page's drill-down.
			const placement = await pointer.evaluate((el) => ({
				inRecipe: !!el.closest('[data-testid="cluster-cron-instructions"]'),
				inAside: !!el.closest('aside')
			}))
			expect(placement.inRecipe, 'jobs-pointer left the takeover card').toBe(true)
			expect(placement.inAside, 'jobs-pointer sits inside the dimmed aside').toBe(false)
		}
	})

	test('the tick log states ownership once and fits a 320px viewport without clipping', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await openClusterCron(page)
		await expect(page.getByTestId('cluster-cron-tick-row').first()).toBeVisible({ timeout: 10_000 })

		// Stated once, above the log - not once per row.
		await expect(page.getByTestId('tick-legend')).toHaveCount(1)
		const rowTexts = await page.getByTestId('cluster-cron-tick-row').allTextContents()
		expect(rowTexts.length).toBeGreaterThan(0)
		for (const text of rowTexts) {
			expect(text, 'tick row repeats the ownership annotation').not.toMatch(/this instance/i)
		}

		const layout = await page.getByTestId('cluster-cron-ticks').evaluate((card) => {
			const rows = [...card.querySelectorAll('[data-testid="cluster-cron-tick-row"]')]
			return {
				card: { client: card.clientWidth, scroll: card.scrollWidth },
				rows: rows.map((row) => {
					const badge = row.querySelector('[data-testid="tick-instance-id"]')
					return {
						client: row.clientWidth,
						scroll: row.scrollWidth,
						badge: badge ? { client: badge.clientWidth, scroll: badge.scrollWidth } : null
					}
				})
			}
		})

		// Non-vacuity: these are block and inline-flex boxes, so the widths are
		// real numbers. A zero would mean the measurement never landed on a laid
		// out element and every comparison below would pass on nothing.
		expect(layout.card.client).toBeGreaterThan(0)
		expect(layout.rows.length).toBeGreaterThan(0)
		expect(layout.card.scroll).toBeLessThanOrEqual(layout.card.client)
		for (const row of layout.rows) {
			expect(row.client).toBeGreaterThan(0)
			expect(row.scroll, 'tick row overflows its column at 320px').toBeLessThanOrEqual(row.client)
			expect(row.badge?.client ?? 0).toBeGreaterThan(0)
			expect(row.badge.scroll, 'instance badge clips at 320px').toBeLessThanOrEqual(row.badge.client)
		}
	})

	test('the takeover recipe is a base surface while the accent stays in the live log', async ({ page }) => {
		await openClusterCron(page)
		await expect(page.getByTestId('cluster-cron-tick-row').first()).toBeVisible({ timeout: 10_000 })

		const recipe = await paintedColor(page.getByTestId('cluster-cron-instructions'), 'backgroundColor')
		const basePanel = await paintedColor(page.getByTestId('cluster-cron-self-panel'), 'backgroundColor')
		const log = await paintedColor(page.getByTestId('cluster-cron-ticks'), 'backgroundColor')

		// A tinted card is a translucent wash over the page (bg-warning/10 keeps
		// alpha 0.1 in the computed value); a base surface is opaque. This is the
		// property, not the class name.
		expect(recipe.alpha, `recipe background ${recipe.raw}`).toBe(1)
		expect(recipe.raw, 'recipe card no longer shares the base-200 surface').toBe(basePanel.raw)
		// Control: base-200 and base-100 must differ, or the equality above would
		// hold for any two cards on the page.
		expect(recipe.raw).not.toBe(log.raw)

		const recipeBorder = await paintedColor(page.getByTestId('cluster-cron-instructions'), 'borderTopColor')
		const logBorder = await paintedColor(page.getByTestId('cluster-cron-ticks'), 'borderTopColor')
		expect(recipeBorder.alpha, `recipe border ${recipeBorder.raw}`).toBe(1)
		expect(recipeBorder.raw, 'recipe card no longer shares the base-300 border').toBe(logBorder.raw)

		// Salience direction: the strongest colour field belongs to the live
		// election, not to the static recipe beside it.
		const badge = await paintedColor(page.getByTestId('tick-instance-id').first(), 'backgroundColor')
		expect(badge.chroma, `leader badge ${badge.raw} is not a chromatic accent`).toBeGreaterThan(0)
		expect(badge.chroma).toBeGreaterThan(recipe.chroma)
	})

	test('/metrics exposes registered leader and cron families with live samples', async ({ page, request }) => {
		await openClusterCron(page)

		const initial = await scrapeMetrics(request)
		if (initial.status === 401 && REMOTE_TARGET) {
			test.skip(true, 'remote metrics require the deployment-specific METRICS_SCRAPE_TOKEN')
		}
		expect(initial.status).toBe(200)
		expect(initial.contentType).toContain('text/plain')
		let body = initial.body
		await expect.poll(async () => {
			const scrape = await scrapeMetrics(request)
			expect(scrape.status).toBe(200)
			body = scrape.body
			return metricSum(body, 'svelte_realtime_cron_total', (labels) => labels.includes('status="ok"'))
		}, { timeout: 15_000 }).toBeGreaterThan(0)

		for (const metric of [
			'leader_acquired_total',
			'leader_renewals_total',
			'leader_lost_total',
			'leader_renewal_failures_total',
			'svelte_realtime_cron_total'
		]) {
			expect(body).toMatch(new RegExp(`^# (HELP|TYPE) ${metric}\\b`, 'm'))
		}
		expect(metricSum(body, 'leader_acquired_total')).toBeGreaterThan(0)
	})

	test.describe('tick time format', () => {
		// en-US is the locale whose bare toLocaleTimeString() renders
		// "9:56:31 PM" - three characters past the log's fixed 80px column.
		// The formatter pins two-digit h23 fields, so even here every tick
		// time must stay at the column's 8-character capacity.
		test.use({ locale: 'en-US' })

		test('tick times hold the fixed column width in a 12-hour locale', async ({ page }) => {
			await openClusterCron(page)
			await expect(page.getByTestId('cluster-cron-tick-row').first()).toBeVisible({ timeout: 10_000 })
			await expect(page.getByTestId('tick-time').first()).toHaveText(/^\d{2}:\d{2}:\d{2}$/)
		})
	})

	test('recent history reaches and stays at the hard 30-row cap with continuous unique sequences', async ({ page }) => {
		test.setTimeout(55_000)
		await openClusterCron(page)
		const rows = page.getByTestId('cluster-cron-tick-row')
		await expect(rows).toHaveCount(TICK_CAP, { timeout: 40_000 })
		expectContinuousNewestFirst(await tickSeqs(page))
		const newestBefore = (await tickSeqs(page))[0]

		await page.waitForTimeout(3_200)
		await expect(rows).toHaveCount(TICK_CAP)
		const after = await tickSeqs(page)
		expectContinuousNewestFirst(after)
		expect(after[0]).toBeGreaterThanOrEqual(newestBefore + 2)
	})
})
