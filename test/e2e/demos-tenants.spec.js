import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
import { switchTenant, waitForWsConfirmed } from './tenants-helpers.js'

test.describe.configure({ mode: 'serial' })

async function open(page) {
	await page.goto('/demos/tenants')
	await waitForWsConfirmed(page)
}

const opacityOf = (locator) => locator.evaluate((el) => Number(getComputedStyle(el).opacity))

async function switchTo(page, tenant) {
	await switchTenant(page, tenant)
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
		// No tenant is active, so the isolation caveat is hypothetical: it says
		// so, and spends no amber on it.
		await expect(page.getByTestId('tn-scope-warning')).toContainText('Picking a tenant will isolate EVERY demo page')
		await expect(page.getByTestId('tn-scope-warning')).not.toHaveClass(/alert-warning/)
		// The lede points at the action the visitor can take from here.
		await expect(page.getByTestId('tn-lede')).toContainText('Pick Acme below')
		const input = page.getByTestId('tn-note-input')
		await expect(input).toHaveAttribute('maxlength', '200')
		await expect(input).toHaveAttribute('placeholder', 'Leave a note...')
		// The scope clause survives as the accessible name rather than as a
		// placeholder that is clipped at 320 and gone once the visitor types.
		await expect(page.getByLabel('Note for this scope')).toBeVisible()
		await expect(page.getByTestId('tn-note-submit')).toBeDisabled()
		await input.fill('   ')
		await expect(page.getByTestId('tn-note-submit')).toBeDisabled()
		await expect(page.getByTestId('tn-switch-error')).toHaveCount(0)
		await expect(page.getByTestId('tn-post-error')).toHaveCount(0)
	})

	/**
	 * The empty pad is the whole first screen in a scope nobody has written to
	 * yet, so it has to be readable rather than a metadata whisper. Holding it
	 * open by dropping only the pad topic keeps the assertion independent of
	 * what the keyspace happens to hold and of where this file sits in a retry,
	 * while `whoami` still lands so the page is genuinely hydrated.
	 */
	test('the empty pad states its emptiness above the metadata floor', async ({ page }) => {
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => {
				if (String(m).includes('demos:tenants:pad')) return
				ws.send(m)
			})
		})
		await open(page)
		const empty = page.getByTestId('tn-notes-empty')
		await expect(empty).toBeVisible()
		expect(await opacityOf(empty)).toBeGreaterThanOrEqual(0.6)
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
		// Isolation is now the live condition: amber, and named in the
		// switcher's own vocabulary rather than the raw id.
		await expect(page.getByTestId('tn-scope-warning')).toHaveClass(/alert-warning/)
		await expect(page.getByTestId('tn-scope-warning')).toContainText('currently isolated to Acme')
		await expect(page.getByTestId('tn-lede')).toContainText('Acme is active')
		await expect(page.getByRole('heading', { level: 2 })).toContainText('Acme scratchpad')
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(publicText)
		await postNote(page, acmeText)

		await switchTo(page, 'globex')
		await expect(page.getByTestId('tn-set-globex')).toBeEnabled()
		await expect(page.getByTestId('tn-set-globex')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByRole('heading', { level: 2 })).toContainText('Globex scratchpad')
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(acmeText)
		await expect(page.getByTestId('tn-notes-list')).not.toContainText(publicText)
		await postNote(page, globexText)

		await switchTo(page, null)
		await expect(page.getByTestId('tn-clear')).toBeEnabled()
		await expect(page.getByTestId('tn-clear')).toHaveAttribute('aria-pressed', 'true')
		// Approached from the isolated side, so this waits for a real
		// transition rather than reading a state that was never amber.
		await expect(page.getByTestId('tn-scope-warning')).not.toHaveClass(/alert-warning/)
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
