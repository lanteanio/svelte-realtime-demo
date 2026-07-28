import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

async function setOrg(page, org) {
	await page.goto('/')
	const result = await page.evaluate(async (nextOrg) => {
		const response = await fetch('/api/demos/set-org', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ org: nextOrg })
		})
		return { status: response.status, body: await response.text() }
	}, org)
	expect(result.status, result.body).toBe(200)
}

async function openAs(page, org) {
	await setOrg(page, org)
	await page.goto('/demos/denials')
	await waitForWS(page)
	await expect(page.getByTestId('my-org')).toHaveText(org)
	await expect.poll(async () => (await page.getByTestId('my-identity').locator('strong').textContent())?.trim(), {
		timeout: 8_000
	}).not.toBe('...')
}

async function expectAccessShape(page, ownOrg, deniedOrg) {
	await expect(page.getByTestId(`banner-${ownOrg}`)).toHaveCount(0)
	await expect(page.getByTestId(`entries-${ownOrg}`)).toBeVisible()
	const banner = page.getByTestId(`banner-${deniedOrg}`)
	await expect(banner).toBeVisible()
	await expect(banner).toContainText('FORBIDDEN')
	await expect(banner).toContainText("You don't work here. The server denied this subscription with FORBIDDEN.")
	await expect(page.getByTestId(`entries-${deniedOrg}`)).toHaveCount(0)
	await expect(page.getByTestId(`card-${ownOrg}`).getByText('your org', { exact: true })).toBeVisible()
	await expect(page.getByTestId(`card-${deniedOrg}`).getByText('your org', { exact: true })).toHaveCount(0)

	const denialRows = page.getByTestId('recent-denials').locator('li').filter({ hasText: `audit:${deniedOrg}` }).filter({ hasText: 'FORBIDDEN' })
	await expect(denialRows.first()).toBeVisible({ timeout: 8_000 })
}

async function append(page, text, { submitWithEnter = false } = {}) {
	await page.getByTestId('append-input').fill(text)
	if (submitWithEnter) await page.getByTestId('append-input').press('Enter')
	else await page.getByTestId('append-button').click()
}

function entryWith(page, org, text) {
	return page.getByTestId(`entries-${org}`).locator('li').filter({ hasText: text })
}

test.describe('/demos/denials', () => {
	for (const [ownOrg, deniedOrg] of [['acme', 'globex'], ['globex', 'acme']]) {
		test(`${ownOrg} identity sees only its log and both denial surfaces name ${deniedOrg}`, async ({ page }) => {
			await openAs(page, ownOrg)
			await expectAccessShape(page, ownOrg, deniedOrg)
			await expect(page.getByTestId(`switch-${ownOrg}`)).toBeEnabled()
			await expect(page.getByTestId(`switch-${ownOrg}`)).toHaveAttribute('aria-pressed', 'true')
			await expect(page.getByTestId(`switch-${ownOrg}`)).toHaveClass(/btn-primary/)
			await expect(page.getByTestId(`switch-${deniedOrg}`)).toBeEnabled()
			await expect(page.getByTestId(`switch-${deniedOrg}`)).toHaveAttribute('aria-pressed', 'false')
		})
	}

	test('switch buttons preserve identity and flip authorization in both directions', async ({ page }) => {
		await openAs(page, 'acme')
		const name = (await page.getByTestId('my-identity').locator('strong').textContent())?.trim()
		await expectAccessShape(page, 'acme', 'globex')

		await page.getByTestId('switch-globex').click()
		await waitForWS(page)
		await expect(page.getByTestId('my-org')).toHaveText('globex')
		await expect(page.getByTestId('my-identity').locator('strong')).toHaveText(name)
		await expectAccessShape(page, 'globex', 'acme')
		await expect(page.getByTestId('switch-globex')).toBeEnabled()
		await expect(page.getByTestId('switch-globex')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('switch-acme')).toBeEnabled()

		await page.getByTestId('switch-acme').click()
		await waitForWS(page)
		await expect(page.getByTestId('my-org')).toHaveText('acme')
		await expect(page.getByTestId('my-identity').locator('strong')).toHaveText(name)
		await expectAccessShape(page, 'acme', 'globex')
	})

	test('switch failure restores controls, keeps the current role, and renders the real HTTP error', async ({ page }) => {
		await openAs(page, 'acme')
		await page.route('**/api/demos/set-org', (route) => route.fulfill({ status: 503, body: 'unavailable' }))

		await page.getByTestId('switch-globex').click()
		await expect(page.getByTestId('append-error')).toHaveText('Switch failed: HTTP 503')
		await expect(page.getByTestId('my-org')).toHaveText('acme')
		await expect(page.getByTestId('switch-acme')).toBeEnabled()
		await expect(page.getByTestId('switch-acme')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('switch-globex')).toBeEnabled()
		await expectAccessShape(page, 'acme', 'globex')
	})

	test('append form validates drafts, truncates at 200, clears, persists, and submits with Enter exactly once', async ({ page }) => {
		await openAs(page, 'acme')
		const actor = (await page.getByTestId('my-identity').locator('strong').textContent())?.trim() ?? ''
		await expect(page.getByTestId('append-button')).toBeDisabled()
		await page.getByTestId('append-input').fill('   ')
		await expect(page.getByTestId('append-button')).toBeDisabled()

		const long = `long-${Date.now()}-` + 'x'.repeat(220)
		const truncated = long.slice(0, 200)
		await append(page, long)
		const longEntry = entryWith(page, 'acme', long.slice(0, 32))
		await expect(longEntry).toHaveCount(1)
		await expect(longEntry.locator('span').nth(1)).toHaveText(actor)
		await expect(longEntry.locator('span').nth(2)).toHaveText(truncated)
		await expect(page.getByTestId('append-input')).toHaveValue('')
		await expect(page.getByTestId('append-button')).toBeDisabled()

		const entered = `enter-${Date.now()}`
		await append(page, entered, { submitWithEnter: true })
		await expect(entryWith(page, 'acme', entered)).toHaveCount(1)
		await page.reload()
		await waitForWS(page)
		await expect(entryWith(page, 'acme', truncated.slice(0, 32))).toHaveCount(1)
		await expect(entryWith(page, 'acme', entered)).toHaveCount(1)
	})

	test('same-session tabs share authorized appends and converge after the second tab reconnects to a switched org', async ({ browser }) => {
		const context = await browser.newContext()
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await openAs(a, 'acme')
			await b.goto('/demos/denials')
			await waitForWS(b)
			await expect(b.getByTestId('my-org')).toHaveText('acme')
			await expect(b.getByTestId('my-identity').locator('strong')).toHaveText(
				(await a.getByTestId('my-identity').locator('strong').textContent())?.trim() ?? ''
			)

			const acmeText = `tabs-acme-${Date.now()}`
			await append(a, acmeText)
			await expect(entryWith(a, 'acme', acmeText)).toHaveCount(1)
			await expect(entryWith(b, 'acme', acmeText)).toHaveCount(1)

			await a.getByTestId('switch-globex').click()
			await waitForWS(a)
			await expect(a.getByTestId('my-org')).toHaveText('globex')
			// B's existing socket retains the old handshake identity until it
			// reconnects; reloading picks up the shared server-side session change.
			await expect(b.getByTestId('my-org')).toHaveText('acme')
			await b.reload()
			await waitForWS(b)
			await expect(b.getByTestId('my-org')).toHaveText('globex')

			const globexText = `tabs-globex-${Date.now()}`
			await append(b, globexText)
			await expect(entryWith(a, 'globex', globexText)).toHaveCount(1)
			await expect(entryWith(b, 'globex', globexText)).toHaveCount(1)
			await expectAccessShape(a, 'globex', 'acme')
			await expectAccessShape(b, 'globex', 'acme')
		} finally {
			await context.close()
		}
	})
})
