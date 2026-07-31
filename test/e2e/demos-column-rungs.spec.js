import { test, expect } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

/**
 * The demo layouts key their multi-column rungs on the .demos-content container
 * (container-type: inline-size), not on the viewport. The container is never as
 * wide as the viewport, so a rung's px value is NOT the viewport width it
 * engages at:
 *
 *   viewport < 1024  ->  container = viewport - 15   (scrollbar gutter)
 *   viewport >= 1024 ->  container = viewport - 223  (13rem sidebar + scrollbar)
 *
 * That is why a container rung must never be set to the viewport width the
 * design is pinned at. An @3xl (768px container) rung does not engage until a
 * 783px viewport, which silently dropped these pages to one column at exactly
 * 768 - iPad portrait - when they were migrated off md: by px value.
 *
 * 768 is therefore the width worth defending: it is a real device width and the
 * one the original md: rung guaranteed.
 */
const TWO_COLUMN_AT_768 = [
	{ path: '/demos/denials', testid: 'denials-columns' },
	{ path: '/demos/pressure', testid: 'pressure-columns' },
	{ path: '/demos/ops', testid: 'ops-columns' },
	{ path: '/demos/lobbies', testid: 'lobbies-columns' }
]

function trackCount(page, testid) {
	return page.getByTestId(testid).evaluate(
		(node) => getComputedStyle(node).gridTemplateColumns.split(' ').length
	)
}

test.describe('demo column rungs', () => {
	for (const { path, testid } of TWO_COLUMN_AT_768) {
		test(`${path} stacks on a phone and is two columns at a 768px viewport`, async ({ page }) => {
			// Start stacked and approach the boundary from the INCLUDED side, so
			// the assertion below waits for a real transition instead of reading a
			// state that already happened to be correct.
			await page.setViewportSize({ width: 390, height: 844 })
			await page.goto(path)
			await expect(page.getByTestId(testid)).toBeVisible({ timeout: 15_000 })
			expect(await trackCount(page, testid), 'must stack on a phone').toBe(1)

			await page.setViewportSize({ width: 768, height: 1024 })
			await expect
				.poll(() => trackCount(page, testid), { timeout: 10_000 })
				.toBe(2)

			// Two real tracks, not one track plus a collapsed zero-width one.
			const widths = await page.getByTestId(testid).evaluate(
				(node) => getComputedStyle(node).gridTemplateColumns.split(' ').map(parseFloat)
			)
			for (const width of widths) expect(width).toBeGreaterThan(200)
		})
	}

	test('the container inset law the rungs depend on still holds', async ({ page }) => {
		await page.goto('/demos/ops')
		await expect(page.getByTestId('ops-columns')).toBeVisible({ timeout: 15_000 })
		const measure = () => page.evaluate(() => ({
			viewport: document.documentElement.clientWidth,
			container: document.querySelector('.demos-content')?.clientWidth ?? -1
		}))

		// Below the sidebar threshold the container trails the viewport only by
		// the scrollbar gutter; at and above it, also by the 13rem sidebar. If
		// either changes, every container rung shifts and the pages above need
		// re-picking - this is the assertion that says so out loud.
		await page.setViewportSize({ width: 768, height: 1024 })
		await expect.poll(async () => (await measure()).container, { timeout: 5_000 }).toBe(753)

		await page.setViewportSize({ width: 1440, height: 900 })
		await expect.poll(async () => (await measure()).container, { timeout: 5_000 }).toBe(1217)
	})
})
