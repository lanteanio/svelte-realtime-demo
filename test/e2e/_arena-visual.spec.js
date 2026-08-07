import { test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Assertion-free visual capture for the arena design cards, in the diagnostics
// tier. Two of those cards are claims about what a human can SEE - a stale
// swatch vanishing into a dark card, and a minimap conveying the received set -
// and neither is fully settled by a class assertion. This renders both themes
// at 3x so the swatch border is actually inspectable rather than a 12px smudge.
//
// Not in the main tier on purpose: it asserts nothing and would only add
// pass-count noise.

const OUT = path.resolve('_screenshots/arena')
fs.mkdirSync(OUT, { recursive: true })

test.use({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 3 })
test.setTimeout(60_000)

for (const theme of ['light', 'dark']) {
	test(`arena HUD and minimap in ${theme}`, async ({ page }) => {
		await page.goto('/demos/arena', { waitUntil: 'networkidle' }).catch(() => {})
		await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
		// Let entities arrive so the minimap has a received set to draw.
		await page.waitForTimeout(3000)

		// The freshness row: live / coasting / stale chips, the last at quarter
		// opacity. Captured with its siblings because the claim is comparative -
		// stale must still read as a chip beside the other two.
		await page.getByTestId('arena-stale-swatch').locator('..')
			.screenshot({ path: path.join(OUT, `freshness-row-${theme}.png`) })

		// The entity-kind legend and the world-overview minimap.
		await page.getByTestId('arena-kind-legend')
			.screenshot({ path: path.join(OUT, `kind-legend-${theme}.png`) })
		await page.getByTestId('arena-minimap')
			.screenshot({ path: path.join(OUT, `minimap-${theme}.png`) })

		await page.screenshot({ path: path.join(OUT, `full-${theme}.png`), fullPage: true })
	})
}
