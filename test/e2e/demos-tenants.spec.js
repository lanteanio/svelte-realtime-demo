import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

/**
 * The tenant readout is confirmed over the socket, so this wait is a
 * connection wait wearing an app-level costume: when the socket never
 * comes up, `tn-ws-pending` simply never clears and the failure reports
 * a selector, naming nothing about why. Route the connection half
 * through `waitForWS` first so a dead socket or a page that never
 * hydrated reports its own timeline, and keep the tenant confirmation
 * as the app-level gate behind it.
 */
async function waitForWsConfirmed(page) {
	await waitForWS(page)
	await expect(page.getByTestId('tn-ws-pending')).toHaveCount(0, { timeout: 15_000 })
	await expect(page.getByTestId('tn-whoami-error')).toHaveCount(0)
}

async function open(page) {
	await page.goto('/demos/tenants')
	await waitForWsConfirmed(page)
}

async function switchTo(page, tenant) {
	const id = tenant === 'acme' ? 'tn-set-acme' : tenant === 'globex' ? 'tn-set-globex' : 'tn-clear'
	await page.getByTestId(id).click()
	await expect(page.getByTestId('tn-active-tenant')).toHaveText(tenant ?? 'none', { timeout: 15_000 })
	await waitForWsConfirmed(page)
	await expect(page.getByTestId('tn-wire-topic')).toHaveText(
		tenant ? `@t/${tenant}/demos:tenants:pad` : 'demos:tenants:pad'
	)
}

async function postNote(page, text) {
	await page.getByTestId('tn-note-input').fill(text)
	await page.getByTestId('tn-note-submit').click()
	const row = page.getByTestId('tn-note-row').filter({ hasText: text.trim() }).first()
	await expect(row).toBeVisible({ timeout: 10_000 })
	await expect(page.getByTestId('tn-note-input')).toHaveValue('')
	return row
}

test.describe('/demos/tenants', () => {
	test('fresh visitor renders the exact public controls, constraints, warning, and pressed active choice', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Multi-tenancy: strict per-connection isolation')
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none')
		await expect(page.getByTestId('tn-wire-topic')).toHaveText('demos:tenants:pad')
		await expect(page.getByLabel('Effective wire topic')).toBeVisible()
		await expect(page.getByRole('heading', { level: 2 })).toContainText('Public scratchpad')
		await expect(page.getByTestId('tn-set-acme')).toBeEnabled()
		await expect(page.getByTestId('tn-set-globex')).toBeEnabled()
		await expect(page.getByTestId('tn-clear')).toBeEnabled()
		await expect(page.getByTestId('tn-clear')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('tn-clear')).toHaveClass(/btn-primary/)
		await expect(page.getByTestId('tn-set-acme')).toHaveAttribute('aria-pressed', 'false')
		await expect(page.getByTestId('tn-scope-warning')).toContainText('EVERY demo page')
		const input = page.getByTestId('tn-note-input')
		await expect(input).toHaveAttribute('maxlength', '200')
		await expect(input).toHaveAttribute('placeholder', 'Leave a note for everyone in this scope...')
		await expect(page.getByTestId('tn-note-submit')).toBeDisabled()
		await input.fill('   ')
		await expect(page.getByTestId('tn-note-submit')).toBeDisabled()
		await expect(page.getByTestId('tn-switch-error')).toHaveCount(0)
		await expect(page.getByTestId('tn-post-error')).toHaveCount(0)
	})

	test('public posts trim whitespace, clear the input, and prepend newest-first', async ({ page }) => {
		await open(page)
		const first = `public-first-${Date.now()}`
		const second = `public-second-${Date.now()}`
		const firstRow = await postNote(page, `   ${first}   `)
		await expect(firstRow.locator('span').last()).toHaveText(first)
		await postNote(page, second)
		await expect(page.getByTestId('tn-note-row').nth(0).locator('span').last()).toHaveText(second)
		await expect(page.getByTestId('tn-note-row').nth(1).locator('span').last()).toHaveText(first)
	})

	test('Public, Acme, and Globex reload into disjoint pads and every switch button reflects the trusted scope', async ({ page }) => {
		await open(page)
		const run = Date.now()
		const publicText = `scope-public-${run}`
		const acmeText = `scope-acme-${run}`
		const globexText = `scope-globex-${run}`
		await postNote(page, publicText)

		await switchTo(page, 'acme')
		await expect(page.getByTestId('tn-set-acme')).toBeEnabled()
		await expect(page.getByTestId('tn-set-acme')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('tn-set-acme')).toHaveClass(/btn-primary/)
		await expect(page.getByTestId('tn-clear')).toBeEnabled()
		await expect(page.getByRole('heading', { level: 2 })).toContainText('acme scratchpad')
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(publicText)
		await postNote(page, acmeText)

		await switchTo(page, 'globex')
		await expect(page.getByTestId('tn-set-globex')).toBeEnabled()
		await expect(page.getByTestId('tn-set-globex')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByRole('heading', { level: 2 })).toContainText('globex scratchpad')
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(acmeText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(publicText)
		await postNote(page, globexText)

		await switchTo(page, null)
		await expect(page.getByTestId('tn-clear')).toBeEnabled()
		await expect(page.getByTestId('tn-clear')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('tn-notes-list')).toContainText(publicText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(acmeText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(globexText)
		await switchTo(page, 'acme')
		await expect(page.getByTestId('tn-notes-list')).toContainText(acmeText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(globexText)
	})

	test('same-tenant tabs receive live notes while a different tenant receives nothing', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const ctxG = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const g = await ctxG.newPage()
		try {
			await Promise.all([open(a), open(b), open(g)])
			await Promise.all([switchTo(a, 'acme'), switchTo(b, 'acme'), switchTo(g, 'globex')])
			const acme = `live-acme-${Date.now()}`
			await postNote(a, acme)
			await expect(b.getByTestId('tn-notes-list')).toContainText(acme, { timeout: 10_000 })
			await expect(g.getByTestId('tn-notes-list')).not.toContainText(acme)
			const globex = `live-globex-${Date.now()}`
			await postNote(g, globex)
			await expect(a.getByTestId('tn-notes-list')).not.toContainText(globex)
			await expect(b.getByTestId('tn-notes-list')).not.toContainText(globex)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close(), ctxG.close()])
		}
	})

	test('set-tenant endpoint rejects unknown tenants and malformed bodies without changing scope', async ({ page }) => {
		await open(page)
		const statuses = await page.evaluate(async () => {
			const post = async (body) => (await fetch('/api/demos/set-tenant', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body
			})).status
			return {
				unknown: await post(JSON.stringify({ tenant: 'initech' })),
				missingKey: await post(JSON.stringify({})),
				garbage: await post('not json')
			}
		})
		expect(statuses).toEqual({ unknown: 400, missingKey: 400, garbage: 400 })
		await page.reload()
		await expect(page.getByTestId('tn-active-tenant')).toHaveText('none', { timeout: 10_000 })
		await waitForWsConfirmed(page)
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			await expectTouchTarget(page.getByTestId('tn-set-acme'))
			await expectTouchTarget(page.getByTestId('tn-set-globex'))
			await expectTouchTarget(page.getByTestId('tn-clear'))
			// Flex-grown composer input: height is the constrained axis.
			await expectTouchTarget(page.getByTestId('tn-note-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('tn-note-submit'))
		} finally {
			await context.close()
		}
	})
})
