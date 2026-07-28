import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'denials cluster coverage requires two explicit replica targets')

async function setOrgAt(page, origin, org) {
	await page.goto(`${origin}/`)
	const status = await page.evaluate(async (nextOrg) => {
		const response = await fetch('/api/demos/set-org', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ org: nextOrg })
		})
		return response.status
	}, org)
	expect(status).toBe(200)
}

async function openAt(page, origin, org) {
	await page.goto(`${origin}/demos/denials`)
	await waitForWS(page)
	await expect(page.getByTestId('my-org')).toHaveText(org)
	await expect(page.getByTestId(`banner-${org}`)).toHaveCount(0)
	await expect(page.getByTestId(`banner-${org === 'acme' ? 'globex' : 'acme'}`)).toContainText('FORBIDDEN')
}

async function append(page, org, text) {
	await page.getByTestId('append-input').fill(text)
	await page.getByTestId('append-button').click()
	await expect(page.getByTestId(`entries-${org}`).locator('li').filter({ hasText: text })).toHaveCount(1)
}

function entry(page, org, text) {
	return page.getByTestId(`entries-${org}`).locator('li').filter({ hasText: text })
}

test.describe('cluster: /demos/denials', () => {
	test('one shared session switches via Redis and authorized appends fan out in both replica directions', async ({ browser }) => {
		const context = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await setOrgAt(a, INSTANCE_A, 'acme')
			await Promise.all([openAt(a, INSTANCE_A, 'acme'), openAt(b, INSTANCE_B, 'acme')])
			await expect(b.getByTestId('my-identity').locator('strong')).toHaveText(
				(await a.getByTestId('my-identity').locator('strong').textContent())?.trim() ?? ''
			)

			const fromA = `replica-a-${Date.now()}`
			await append(a, 'acme', fromA)
			await expect(entry(b, 'acme', fromA)).toHaveCount(1)

			const fromB = `replica-b-${Date.now()}`
			await append(b, 'acme', fromB)
			await expect(entry(a, 'acme', fromB)).toHaveCount(1)

			// A mutates the server-side session through replica A. A reloads in
			// the UI; B then reconnects through replica B and must read Globex
			// from the same Redis-backed identity session.
			await a.getByTestId('switch-globex').click()
			await waitForWS(a)
			await expect(a.getByTestId('my-org')).toHaveText('globex')
			await b.reload()
			await waitForWS(b)
			await expect(b.getByTestId('my-org')).toHaveText('globex')
			await expect(a.getByTestId('banner-acme')).toContainText('FORBIDDEN')
			await expect(b.getByTestId('banner-acme')).toContainText('FORBIDDEN')

			const globexFromB = `globex-b-${Date.now()}`
			await append(b, 'globex', globexFromB)
			await expect(entry(a, 'globex', globexFromB)).toHaveCount(1)
		} finally {
			await context.close()
		}
	})
})
