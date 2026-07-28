import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'effect cluster coverage requires two explicit replica targets')

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/effect`)
	await waitForWS(page)
}

async function expectCounts(page, count) {
	await Promise.all([
		expect(page.getByTestId('orders-row')).toHaveCount(count, { timeout: 12_000 }),
		expect(page.getByTestId('audit-row')).toHaveCount(count, { timeout: 12_000 }),
		expect(page.getByTestId('notifications-row')).toHaveCount(count, { timeout: 12_000 })
	])
}

async function clear(page) {
	await confirmAndClick(page.getByTestId('clear'))
	await expectCounts(page, 0)
}

async function place(page, product, qty) {
	await page.getByTestId('place-product').selectOption(product)
	await page.getByTestId('place-qty').fill(String(qty))
	await page.getByTestId('place-submit').click()
}

test.describe('cluster: /demos/effect', () => {
	test('orders fan out both directions while the leader gate emits each side effect exactly once', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await clear(a)
			await expectCounts(b, 0)

			// Every replica observes the source order. Without the leader gate,
			// each would append its own audit + notification and these exact-one
			// assertions would receive 2 (or 4 on the public topology).
			await place(a, 'coffee', 2)
			await expectCounts(a, 1)
			await expectCounts(b, 1)
			await expect(a.getByTestId('audit-message')).toContainText('2x coffee for $10')
			await expect(b.getByTestId('notifications-message')).toContainText('2x coffee')

			await place(b, 'cookie', 3)
			await expectCounts(a, 2)
			await expectCounts(b, 2)
			await pageCountsStayStable(a, b, 2)

			await clear(b)
			await expectCounts(a, 0)
			await expectCounts(b, 0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})

async function pageCountsStayStable(a, b, count) {
	await a.waitForTimeout(600)
	await expectCounts(a, count)
	await expectCounts(b, count)
}
