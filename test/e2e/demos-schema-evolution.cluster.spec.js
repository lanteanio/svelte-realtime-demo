import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick } from './helpers.js'

const IDS = ['alpha', 'beta', 'gamma']
const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'schema-evolution cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/schema-evolution`)
	await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
	await expect(page.getByTestId('v1mig-card')).toHaveCount(3, { timeout: 8_000 })
}

async function expectAll(page, value) {
	for (const id of IDS) {
		await expect(page.getByTestId(`v2-value-${id}`)).toHaveText(String(value))
		await expect(page.getByTestId(`v1mig-value-${id}`)).toHaveText(String(value))
	}
}

async function reset(page) {
	await confirmAndClick(page.getByTestId('reset'))
	await expectAll(page, 0)
}

test.describe('cluster: /demos/schema-evolution', () => {
	test('concurrent same-key increments on separate replicas are atomic and publish value 2 everywhere', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await reset(a)
			await Promise.all([
				a.getByTestId('bump-alpha').click(),
				b.getByTestId('bump-alpha').click()
			])
			for (const page of [a, b]) {
				await expect(page.getByTestId('v2-value-alpha')).toHaveText('2')
				await expect(page.getByTestId('v1mig-value-alpha')).toHaveText('2')
				await expect(page.getByTestId('v1mig-provenance-alpha')).toHaveText('loader')
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('Reset on replica B zeroes all keys on A and raw publishes flip both stale projections to loader', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await reset(a)
			await a.getByTestId('bump-beta').click()
			await expect(a.getByTestId('v2-value-beta')).toHaveText('1')
			await a.getByTestId('bump-gamma').click()
			await expect(b.getByTestId('v2-value-beta')).toHaveText('1')
			await expect(b.getByTestId('v2-value-gamma')).toHaveText('1')
			await reset(b)
			await expectAll(a, 0)
			for (const page of [a, b]) {
				for (const id of IDS) await expect(page.getByTestId(`v1mig-provenance-${id}`)).toHaveText('loader')
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
