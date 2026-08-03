import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'tenants cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

// Same reasoning as the single-instance spec: the pending marker is a
// connection wait in app clothing, so the connection half reports its
// own timeline before the tenant confirmation is asked for.
async function openAt(page, origin) {
	await page.goto(`${origin}/demos/tenants`)
	await waitForWS(page)
	await expect(page.getByTestId('tn-ws-pending')).toHaveCount(0, { timeout: 15_000 })
}

async function switchTo(page, tenant) {
	const id = tenant === 'acme' ? 'tn-set-acme' : 'tn-set-globex'
	await page.getByTestId(id).click()
	await expect(page.getByTestId('tn-active-tenant')).toHaveText(tenant, { timeout: 15_000 })
	await expect(page.getByTestId('tn-ws-pending')).toHaveCount(0, { timeout: 15_000 })
}

async function post(page, text) {
	await page.getByTestId('tn-note-input').fill(text)
	await page.getByTestId('tn-note-submit').click()
	await expect(page.getByTestId('tn-note-row').filter({ hasText: text })).toBeVisible({ timeout: 10_000 })
}

test.describe('cluster: /demos/tenants', () => {
	test('Acme on replica A cannot leak to Globex on B; switching B to Acme loads and joins the shared scope', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await Promise.all([switchTo(a, 'acme'), switchTo(b, 'globex')])
			const text = `cluster-isolation-${Date.now()}`
			await post(a, text)
			// A bare `not.toContainText` is satisfied by its first evaluation and
			// returns immediately, while `post` only waited for A's OWN row - so a
			// leaked note arriving one cross-replica relay later would land after
			// this line had already passed. Give the relay a positive control to
			// beat: post on B's own tenant and wait for THAT to render. Anything
			// leaking from A has had at least a full relay to appear by then.
			const canary = `cluster-canary-${Date.now()}`
			await post(b, canary)
			await expect(b.getByTestId('tn-notes-list')).toContainText(canary)
			await expect(b.getByTestId('tn-notes-list')).not.toContainText(text)
			await switchTo(b, 'acme')
			await expect(b.getByTestId('tn-notes-list')).toContainText(text, { timeout: 10_000 })
			const reply = `cluster-reply-${Date.now()}`
			await post(b, reply)
			await expect(a.getByTestId('tn-notes-list')).toContainText(reply, { timeout: 10_000 })
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('simultaneous same-tenant posts on separate replicas preserve both newest entries everywhere', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await Promise.all([switchTo(a, 'globex'), switchTo(b, 'globex')])
			const textA = `cluster-a-${Date.now()}`
			const textB = `cluster-b-${Date.now()}`
			await Promise.all([post(a, textA), post(b, textB)])
			for (const page of [a, b]) {
				await expect(page.getByTestId('tn-note-row').filter({ hasText: textA })).toHaveCount(1)
				await expect(page.getByTestId('tn-note-row').filter({ hasText: textB })).toHaveCount(1)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
