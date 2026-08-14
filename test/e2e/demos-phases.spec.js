import { test, expect } from '@playwright/test'
import {
	attach,
	detach,
	feedRows,
	openPhases,
	publishPair,
	waitForPair
} from './phases-helpers.js'

test.describe('/demos/phases', () => {
	test('renders the complete lifecycle, atomic-batch controls, disclosure, and source link', async ({ page }) => {
		await openPhases(page)
		await expect(page.getByRole('heading', { name: 'Phases: attach lifecycle + atomic publish batch' })).toBeVisible()
		await expect(page.getByTestId('ph-lifecycle-card')).toBeVisible()
		await expect(page.getByTestId('ph-batch-card')).toBeVisible()
		await expect(page.getByTestId('ph-attach')).toBeVisible()
		await expect(page.getByTestId('ph-attach')).toBeDisabled()
		await expect(page.getByTestId('ph-detach')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-fail')).toBeEnabled()
		await expect(page.getByText('initialized -> attaching -> attached -> detached | failed', { exact: false })).toBeVisible()
		await expect(page.getByText('Both buttons run the same handler:', { exact: false })).toBeVisible()
		await expect(page.getByRole('link', { name: 'phases.js' })).toHaveAttribute(
			'href',
			/src\/live\/demos\/phases\.js$/
		)
		await expect(page.getByTestId('ph-attach-error')).toHaveCount(0)
		await expect(page.getByTestId('ph-batch-error')).toHaveCount(0)
		// The count line only exists once it says something the empty
		// state does not already say.
		const rows = await page.getByTestId('ph-feed-row').count()
		if (rows === 0) {
			await expect(page.getByTestId('ph-feed-empty')).toBeVisible()
			await expect(page.getByTestId('ph-feed-count')).toHaveCount(0)
		} else {
			expect(Number(await page.getByTestId('ph-feed-count').textContent())).toBe(rows)
		}
		expect(rows).toBeLessThanOrEqual(10)
	})

	test('detach hides and releases the feed, while attach reloads work published during detachment', async ({ page }) => {
		await openPhases(page)
		await detach(page)
		await expect(page.getByTestId('ph-feed')).toHaveCount(0)
		await expect(page.getByTestId('ph-feed-hidden')).toContainText('subscription is detached')
		await expect(page.getByTestId('ph-attach')).toBeEnabled()
		await expect(page.getByTestId('ph-detach')).toBeDisabled()

		const ids = await publishPair(page)
		await expect(page.getByTestId('ph-feed')).toHaveCount(0)
		await attach(page)
		await expect(page.getByTestId('ph-attach')).toBeDisabled()
		await expect(page.getByTestId('ph-detach')).toBeEnabled()
		await waitForPair(page, ids)
	})

	test('Publish pair flushes two ordered, identifiable entries atomically', async ({ page }) => {
		await openPhases(page)
		const ids = await publishPair(page)
		expect(new Set(ids).size).toBe(2)
		const pair = await waitForPair(page, ids)
		expect(pair).toEqual([
			{ half: 'first', label: 'first half', id: ids[0] },
			{ half: 'second', label: 'second half', id: ids[1] }
		])
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()
		await expect(page.getByTestId('ph-publish-fail')).toBeEnabled()
	})

	test('Fail midway surfaces validation, states the retraction, publishes nothing, and clears on the next successful action', async ({ page }) => {
		await openPhases(page)
		const before = await feedRows(page)
		await page.getByTestId('ph-publish-fail').click()
		await expect(page.getByTestId('ph-batch-error')).toContainText('VALIDATION: midway failure - nothing above was published')
		// The proof used to rest on a number not moving; now the page
		// says outright that a buffered publish existed and was dropped.
		await expect(page.getByTestId('ph-retraction')).toContainText('was already buffered')
		await expect(page.getByTestId('ph-retraction')).toContainText(`still shows ${before.length} ${before.length === 1 ? 'entry' : 'entries'}`)
		await page.waitForTimeout(1_500)
		expect(await feedRows(page)).toEqual(before)
		await expect(page.getByTestId('ph-last-pair')).toHaveCount(0)
		await expect(page.getByTestId('ph-publish-pair')).toBeEnabled()

		const ids = await publishPair(page)
		await expect(page.getByTestId('ph-batch-error')).toHaveCount(0)
		await expect(page.getByTestId('ph-retraction')).toHaveCount(0)
		await waitForPair(page, ids)
		expect(Number(await page.getByTestId('ph-feed-count').textContent())).toBeGreaterThan(0)
	})

	test('the transition log records every hop, including the ones the badge is too fast to show', async ({ page }) => {
		await openPhases(page)
		const logText = () => page.getByTestId('ph-transition-row').allTextContents()
		// The auto-attach happened before any human could watch the badge,
		// and the log still has the whole chain.
		await expect.poll(logText).toEqual([
			expect.stringContaining('initialized -> attaching'),
			expect.stringContaining('attaching -> attached')
		])
		await detach(page)
		// Observed store truth: detach hops through initialized on its way
		// to detached (attached -> initialized -> detached), an edge the
		// header's summary chain does not document. The log records what
		// the store emits, so the assertion pins the emitted truth.
		await expect.poll(async () => (await logText()).at(-1)).toContain('-> detached')
		await attach(page)
		await expect.poll(async () => (await logText()).at(-1)).toContain('attaching -> attached')
	})

	test('the lifecycle card invites the drill, dresses Detach as a button, and glosses resume-grace', async ({ page }) => {
		await openPhases(page)
		await expect(page.getByTestId('ph-detach')).toHaveClass(/btn-outline/)
		const copy = page.getByTestId('ph-lifecycle-copy')
		await expect(copy).toContainText('This page attached for you on load')
		await expect(copy).toContainText('the log above')
		await expect(copy.getByRole('link', { name: /counter-resume/ })).toHaveAttribute('href', '/demos/counter-resume')
	})

	// A raw "CODE: message" tells a visitor what broke internally and nothing
	// about what to do, so the framing and the recovery hint are what matter.
	// This branch was recorded as unreachable, which left the copy unpinned and
	// free to be deleted silently. It is reachable: an attach in flight when the
	// socket drops fails for real, which is a genuine failure rather than a
	// simulated error string. The interception arms immediately before the
	// click so it cannot fire during load or detach.
	test('a failed attach explains itself and says what to do next', async ({ page }) => {
		let armed = false
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((message) => {
				server.send(message)
				if (armed) ws.close()
			})
			server.onMessage((message) => ws.send(message))
		})
		await openPhases(page)
		await detach(page)
		await expect(page.getByTestId('ph-attach')).toBeEnabled()

		armed = true
		await page.getByTestId('ph-attach').click()

		const error = page.getByTestId('ph-attach-error')
		await expect(error).toBeVisible({ timeout: 20_000 })
		// Both halves of the request: name the operation that failed, and give
		// the visitor a next step. The underlying code stays visible, so this
		// frames the raw message rather than hiding it.
		await expect(error).toContainText('Attach failed')
		await expect(error).toContainText('Try Attach again')
	})
})
