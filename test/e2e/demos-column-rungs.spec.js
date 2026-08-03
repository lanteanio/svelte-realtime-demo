import { test, expect } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

/**
 * The demo layouts key their multi-column rungs on the .demos-content container
 * (container-type: inline-size), not on the viewport. The container is never as
 * wide as the viewport, so a rung's px value is NOT the viewport width it
 * engages at:
 *
 *   viewport < 1024  ->  container = viewport - scrollbar gutter
 *   viewport >= 1024 ->  container = viewport - scrollbar gutter - 13rem sidebar
 *
 * The gutter is platform-dependent: ~15px for a classic scrollbar (Windows,
 * ubuntu CI), 0 under overlay scrollbars (macOS). That is why a container rung
 * must never be set to the viewport width the design is pinned at. An @3xl
 * (768px container) rung does not engage until a 783px viewport on a
 * classic-scrollbar platform, which silently dropped these pages to one column
 * at exactly 768 - iPad portrait - when they were migrated off md: by px value.
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
		// app.css sets scrollbar-gutter: stable on the root, which reserves the
		// platform's gutter inside the root scroller whether or not it overflows
		// (documentElement.clientWidth stays at the viewport width regardless).
		// body.clientWidth is therefore the width the shell really receives:
		// viewport minus the reserved gutter, which is ~15px for a classic
		// scrollbar and 0 under overlay scrollbars. Asserting against it keeps
		// the law platform-neutral instead of hard-coding one gutter width.
		// The @container rungs key on the CONTENT box of .demos-content, so
		// that is what gets measured - clientWidth alone would stay green if a
		// padding regression quietly shrank every rung's capacity.
		const measure = () => page.evaluate(() => {
			const node = document.querySelector('.demos-content')
			let container = -1
			if (node) {
				const cs = getComputedStyle(node)
				container = node.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
			}
			return {
				gutter: window.innerWidth - document.body.clientWidth,
				available: document.body.clientWidth,
				container
			}
		})

		// Below the sidebar threshold the container trails the viewport only by
		// the scrollbar gutter; at and above it, also by the 13rem sidebar. If
		// either changes, every container rung shifts and the pages above need
		// re-picking - this is the assertion that says so out loud.
		// Poll on the inset (available minus container) so both sides of the
		// comparison come from the same measurement - a scrollbar appearing
		// mid-hydration shifts both together instead of racing the assertion.
		const inset = async () => {
			const m = await measure()
			return m.available - m.container
		}

		await page.setViewportSize({ width: 768, height: 1024 })
		await expect.poll(inset, { timeout: 5_000 }).toBe(0)
		const narrow = await measure()
		expect(narrow.gutter, 'scrollbar gutter outside any real platform range').toBeGreaterThanOrEqual(0)
		expect(narrow.gutter, 'scrollbar gutter outside any real platform range').toBeLessThanOrEqual(20)

		await page.setViewportSize({ width: 1440, height: 900 })
		await expect.poll(inset, { timeout: 5_000 }).toBe(208)
	})
})
