import { test, expect } from '@playwright/test'

const RUN = `e2e-${Date.now()}`

test.describe('/demos/schema-evolution', () => {
	test('renders both panels with three counters; v2 panel shows loader, v1mig panel shows migrate[1]', async ({ page }) => {
		await page.goto('/demos/schema-evolution')

		// Three rows in each panel.
		await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
		await expect(page.getByTestId('v1mig-card')).toHaveCount(3, { timeout: 8_000 })

		// v2 panel: every row's provenance badge reads `loader`.
		const v2Badges = page.getByTestId('v2-provenance')
		await expect(v2Badges).toHaveCount(3)
		for (let i = 0; i < 3; i++) {
			await expect(v2Badges.nth(i)).toHaveText('loader')
		}

		// v1mig panel: every row's provenance badge reads `migrate[1]`.
		// Server's migrate chain ran on the initial subscribe response.
		for (const id of ['alpha', 'beta', 'gamma']) {
			await expect(page.getByTestId(`v1mig-provenance-${id}`)).toHaveText('migrate[1]', { timeout: 8_000 })
		}
	})

	test('increment alpha: v2 panel value updates; v1mig panel value updates AND alpha badge flips to `loader`', async ({ page }) => {
		await page.goto('/demos/schema-evolution')

		// Reset so we don't accumulate across reruns of the spec.
		await page.getByTestId('reset').click()
		// After reset, both panels' alpha values are 0; v1mig alpha may
		// still show migrate[1] if the reset publish hasn't reached it
		// (the publish IS a raw v2 event, so it should flip to loader).
		await expect(page.getByTestId('v2-value-alpha')).toHaveText('0', { timeout: 5_000 })
		await expect(page.getByTestId('v1mig-value-alpha')).toHaveText('0', { timeout: 5_000 })

		// Refresh the page so the v1mig panel re-runs its migrate-chain
		// initial subscribe (gives us a clean baseline of all `migrate[1]`).
		await page.reload()
		for (const id of ['alpha', 'beta', 'gamma']) {
			await expect(page.getByTestId(`v1mig-provenance-${id}`)).toHaveText('migrate[1]', { timeout: 8_000 })
		}

		// Increment alpha. The publish is a raw v2 event with provenance:'loader'.
		await page.getByTestId('bump-alpha').click()

		// v2 panel: alpha value now 1, badge stays `loader`.
		await expect(page.getByTestId('v2-value-alpha')).toHaveText('1', { timeout: 5_000 })

		// v1mig panel: alpha value now 1, AND alpha's badge flipped to `loader`
		// (the raw v2 publish replaced the migrated base for that key).
		await expect(page.getByTestId('v1mig-value-alpha')).toHaveText('1', { timeout: 5_000 })
		await expect(page.getByTestId('v1mig-provenance-alpha')).toHaveText('loader', { timeout: 5_000 })

		// Untouched rows on the v1mig panel still wear the `migrate[1]` badge.
		await expect(page.getByTestId('v1mig-provenance-beta')).toHaveText('migrate[1]')
		await expect(page.getByTestId('v1mig-provenance-gamma')).toHaveText('migrate[1]')
	})

	test('after a publish, the migrated row is indistinguishable from a fresh-subscriber row', async ({ page }) => {
		await page.goto('/demos/schema-evolution')

		await page.getByTestId('reset').click()
		await page.reload()

		// Gate on the v2 stream being live (the reset baseline delivered)
		// before publishing: the bumps otherwise race ahead of the re-subscribe
		// and their RPCs are lost, leaving beta at 0.
		await expect(page.getByTestId('v2-value-beta')).toHaveText('0', { timeout: 8_000 })

		// bump() debounces on an in-flight `busy` flag, so a click landing
		// before the previous increment resolves is dropped. Serialize the
		// three bumps, waiting for each to reflect before the next.
		await page.getByTestId('bump-beta').click()
		await expect(page.getByTestId('v2-value-beta')).toHaveText('1', { timeout: 5_000 })
		await page.getByTestId('bump-beta').click()
		await expect(page.getByTestId('v2-value-beta')).toHaveText('2', { timeout: 5_000 })
		await page.getByTestId('bump-beta').click()

		// Both panels converge on value=3 for beta with provenance=loader.
		await expect(page.getByTestId('v2-value-beta')).toHaveText('3', { timeout: 8_000 })
		await expect(page.getByTestId('v1mig-value-beta')).toHaveText('3', { timeout: 8_000 })
		await expect(page.getByTestId('v1mig-provenance-beta')).toHaveText('loader')
	})

	test('migrate config snippet is rendered on the page', async ({ page }) => {
		await page.goto('/demos/schema-evolution')
		const src = page.getByTestId('migrate-source')
		await expect(src).toContainText('version: 2', { timeout: 5_000 })
		await expect(src).toContainText('migrate: { 1: v1ToV2 }')
		await expect(src).toContainText("merge: 'crud'")
	})
})
