import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'flash-sales cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/flash-sales`)
	await waitForWS(page)
	await expect(page.getByTestId('product-card-phone')).toBeVisible()
}

async function reset(page) {
	await confirmAndClick(page.getByTestId('reset'))
	await expect(page.getByTestId('product-stock-phone')).toHaveText('5 / 5 left')
	await expect(page.getByTestId('sales-row')).toHaveCount(0)
}

async function setStress(page, count) {
	await page.getByTestId('stress-target').selectOption('phone')
	await page.getByTestId('stress-count').fill(String(count))
}

async function tally(page, id) {
	const text = await page.getByTestId(id).textContent()
	return Number(text?.match(/^\d+/)?.[0] ?? NaN)
}

test.describe('cluster: /demos/flash-sales', () => {
	test('simultaneous replica stress sells exactly five shared units with no oversell', async ({ browser }) => {
		test.setTimeout(45_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await reset(a)
			await expect(b.getByTestId('product-stock-phone')).toHaveText('5 / 5 left')
			await Promise.all([setStress(a, 8), setStress(b, 8)])
			await Promise.all([
				a.getByTestId('stress-go').click(),
				b.getByTestId('stress-go').click()
			])
			// The tally element appears the moment the burst STARTS - the page
			// zeroes it before firing so the FIFO drain is visible while it runs -
			// so its presence times the click, not the outcome. Reading the badges
			// here sampled a burst still in flight and scored the shared stock at
			// whatever had settled so far. Completion is the button returning from
			// "Running..." to its rest label; wait for the tally first so the
			// rest label being asserted is the one AFTER the run rather than the
			// one still standing before Svelte has applied the click.
			await Promise.all([
				expect(a.getByTestId('stress-result')).toBeVisible({ timeout: 20_000 }),
				expect(b.getByTestId('stress-result')).toBeVisible({ timeout: 20_000 })
			])
			await Promise.all([
				expect(a.getByTestId('stress-go')).not.toHaveText('Running...', { timeout: 30_000 }),
				expect(b.getByTestId('stress-go')).not.toHaveText('Running...', { timeout: 30_000 })
			])

			const ok = (await tally(a, 'stress-ok')) + (await tally(b, 'stress-ok'))
			const outcomesA = (await tally(a, 'stress-ok')) + (await tally(a, 'stress-soldout')) + (await tally(a, 'stress-locktimeout'))
			const outcomesB = (await tally(b, 'stress-ok')) + (await tally(b, 'stress-soldout')) + (await tally(b, 'stress-locktimeout'))
			expect(ok).toBe(5)
			expect(outcomesA).toBe(8)
			expect(outcomesB).toBe(8)
			for (const page of [a, b]) {
				await expect(page.getByTestId('product-soldout-phone')).toBeVisible()
				await expect(page.getByTestId('product-sold-phone')).toHaveText('sold: 5')
				await expect(page.getByTestId('sales-row')).toHaveCount(5)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('same-user concurrent claims on separate replicas decrement the coupon pool once', async ({ browser }) => {
		const context = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await reset(a)
			await openAt(b, INSTANCE_B)
			await expect(b.getByTestId('coupon-pool')).toHaveText('50')

			await Promise.all([
				a.getByTestId('coupon-claim').click(),
				b.getByTestId('coupon-claim').click()
			])
			await expect(a.getByTestId('coupon-pool')).toHaveText('49')
			await expect(b.getByTestId('coupon-pool')).toHaveText('49')
			await Promise.all([
				a.getByTestId('coupon-claim').click(),
				b.getByTestId('coupon-claim').click()
			])
			await expect(a.getByTestId('coupon-pool')).toHaveText('49')
			await expect(b.getByTestId('coupon-pool')).toHaveText('49')
		} finally {
			await context.close()
		}
	})
})
