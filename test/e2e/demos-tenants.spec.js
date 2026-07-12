import { test, expect } from '@playwright/test'

/**
 * /demos/tenants - strict per-connection tenant isolation.
 *
 * Each Playwright test gets a fresh browser context, so every test
 * starts with a brand-new identity session and no tenant. Switching
 * happens through the page's own buttons (POST /api/demos/set-tenant
 * followed by location.reload(), because the tenant resolver runs at
 * WebSocket upgrade).
 */

/**
 * Wait until the page's whoami RPC has round-tripped over the live
 * connection. Gates note-posting so the RPC never races the WS open,
 * and proves the badge shows the server-trusted tenant.
 */
async function waitForWsConfirmed(page) {
	await expect(page.getByTestId('tn-ws-pending')).toHaveCount(0, { timeout: 15_000 })
}

async function postNote(page, text) {
	await page.getByTestId('tn-note-input').fill(text)
	await page.getByTestId('tn-note-submit').click()
	await expect(page.getByTestId('tn-notes-list')).toContainText(text, { timeout: 10_000 })
}

test.describe('/demos/tenants', () => {
	test('fresh visitor is unscoped and posts to the public pad', async ({ page }) => {
		await page.goto('/demos/tenants')
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none', { timeout: 10_000 })
		await waitForWsConfirmed(page)

		const text = `e2e-public-${Date.now()}`
		await postNote(page, text)
	})

	test('tenant switch isolates the pad end-to-end', async ({ page }) => {
		// Step 1: no tenant - post to the public pad.
		await page.goto('/demos/tenants')
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none', { timeout: 10_000 })
		await waitForWsConfirmed(page)

		const publicText = `e2e-shared-${Date.now()}`
		await postNote(page, publicText)

		// Step 2: switch to Acme via the page button. The button POSTs
		// /api/demos/set-tenant and reloads; the reloaded connection is
		// scoped to @t/acme/.
		await page.getByTestId('tn-set-acme').click()
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('acme', { timeout: 15_000 })
		await waitForWsConfirmed(page)

		// Post an Acme note; it appears, and the public note does NOT -
		// the Acme-scoped stream loader reads a different Redis key and
		// the connection cannot subscribe to the unscoped topic.
		const acmeText = `e2e-acme-${Date.now()}`
		await postNote(page, acmeText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(publicText)

		// Step 3: clear the tenant. The original public list returns and
		// the Acme note is gone.
		await page.getByTestId('tn-clear').click()
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none', { timeout: 15_000 })
		await waitForWsConfirmed(page)

		await expect(page.getByTestId('tn-notes-list')).toContainText(publicText, { timeout: 10_000 })
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(acmeText)
	})

	test('set-tenant endpoint rejects unknown tenants and malformed bodies', async ({ page }) => {
		await page.goto('/demos/tenants')
		await waitForWsConfirmed(page)

		const statuses = await page.evaluate(async () => {
			const post = async (body) => {
				const r = await fetch('/api/demos/set-tenant', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body
				})
				return r.status
			}
			return {
				unknown: await post(JSON.stringify({ tenant: 'initech' })),
				missingKey: await post(JSON.stringify({})),
				garbage: await post('not json')
			}
		})
		expect(statuses.unknown).toBe(400)
		expect(statuses.missingKey).toBe(400)
		expect(statuses.garbage).toBe(400)

		// The failed attempts must not have scoped the session.
		await page.reload()
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none', { timeout: 10_000 })
	})
})
