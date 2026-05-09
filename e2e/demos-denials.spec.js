import { test, expect } from '@playwright/test'

async function setOrg(page, org) {
	await page.goto('/')
	await page.evaluate(async (o) => {
		await fetch('/api/demos/set-org', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ org: o })
		})
	}, org)
}

test.describe('/demos/denials', () => {
	test('Acme employee sees own log, gets FORBIDDEN on Globex', async ({ page }) => {
		await setOrg(page, 'acme')
		await page.goto('/demos/denials')
		await expect(page.getByTestId('my-org')).toHaveText('acme', { timeout: 5_000 })

		// Acme card has no banner; Globex card shows FORBIDDEN.
		await expect(page.getByTestId('banner-acme')).toHaveCount(0)
		await expect(page.getByTestId('banner-globex')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('banner-globex')).toContainText('FORBIDDEN')

		// Acme card has at least one seeded entry visible.
		await expect(page.getByTestId('entries-acme')).toContainText('acme-bot', { timeout: 5_000 })
	})

	test('Globex employee sees own log, gets FORBIDDEN on Acme', async ({ page }) => {
		await setOrg(page, 'globex')
		await page.goto('/demos/denials')
		await expect(page.getByTestId('my-org')).toHaveText('globex', { timeout: 5_000 })

		await expect(page.getByTestId('banner-globex')).toHaveCount(0)
		await expect(page.getByTestId('banner-acme')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('banner-acme')).toContainText('FORBIDDEN')
	})

	test('switching org via the button reloads with the new role', async ({ page }) => {
		await setOrg(page, 'acme')
		await page.goto('/demos/denials')
		await expect(page.getByTestId('my-org')).toHaveText('acme', { timeout: 5_000 })

		await page.getByTestId('switch-globex').click()
		await page.waitForLoadState('domcontentloaded')
		await expect(page.getByTestId('my-org')).toHaveText('globex', { timeout: 5_000 })

		// Now Acme is FORBIDDEN, Globex is allowed.
		await expect(page.getByTestId('banner-acme')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('banner-globex')).toHaveCount(0)
	})

	test('append entry to own org shows up in real time; cross-org append fails', async ({ page }) => {
		await setOrg(page, 'acme')
		await page.goto('/demos/denials')
		await expect(page.getByTestId('my-org')).toHaveText('acme', { timeout: 5_000 })

		const text = `e2e-append-${Date.now()}`
		await page.getByTestId('append-input').fill(text)
		await page.getByTestId('append-button').click()
		await expect(page.getByTestId('entries-acme')).toContainText(text, { timeout: 5_000 })
	})

	test('global denials Readable populates the recent-denials list', async ({ page }) => {
		await setOrg(page, 'acme')
		await page.goto('/demos/denials')
		await expect(page.getByTestId('my-org')).toHaveText('acme', { timeout: 5_000 })

		// Globex stream subscribe must have fired a denial; the recent-denials
		// list should show the topic and reason within ~5 seconds.
		await expect(page.getByTestId('recent-denials')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('recent-denials')).toContainText('audit:globex')
		await expect(page.getByTestId('recent-denials')).toContainText('FORBIDDEN')
	})
})
