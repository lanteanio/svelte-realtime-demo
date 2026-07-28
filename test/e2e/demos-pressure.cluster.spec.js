import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'pressure cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/pressure`)
	await waitForWS(page)
	await expect(page.getByTestId('reason')).not.toHaveText('...', { timeout: 10_000 })
}

async function clear(page) {
	await confirmAndClick(page.getByTestId('clear-shed'))
	await expect(page.getByTestId('shed-row')).toHaveCount(0)
}

test.describe('cluster: /demos/pressure', () => {
	test('a shed decision created on replica A is visible on B and a Clear on B removes it from A', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await clear(a)
			await a.getByTestId('simulate-shed').click()
			for (const page of [a, b]) {
				await expect(page.getByTestId('shed-row')).toHaveCount(1)
				await expect(page.getByTestId('shed-row').first()).toContainText('simulateShed')
				await expect(page.getByTestId('shed-row').first()).toContainText('PUBLISH_RATE')
				await expect(page.getByTestId('shed-row').first()).toContainText('simulated')
			}
			await clear(b)
			await expect(a.getByTestId('shed-row')).toHaveCount(0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('simultaneous replica decisions preserve both Redis rows and publish both everywhere', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await clear(a)
			await Promise.all([
				a.getByTestId('simulate-shed').click(),
				b.getByTestId('simulate-shed').click()
			])
			for (const page of [a, b]) {
				await expect(page.getByTestId('shed-row')).toHaveCount(2)
				for (let i = 0; i < 2; i++) {
					await expect(page.getByTestId('shed-row').nth(i)).toContainText('simulateShed')
					await expect(page.getByTestId('shed-row').nth(i)).toContainText('simulated')
				}
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
