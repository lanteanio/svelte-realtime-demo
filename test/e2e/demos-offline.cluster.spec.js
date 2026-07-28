import { test } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { openOffline, postEntry, waitExactlyOnce } from './offline-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'offline cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/offline', () => {
	test('posts from either explicit replica converge once and in newest-first order', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([
				openOffline(a, `${INSTANCE_A}/demos/offline`),
				openOffline(b, `${INSTANCE_B}/demos/offline`)
			])
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const fromA = `cluster-a-${stamp}`
			const fromB = `cluster-b-${stamp}`
			await postEntry(a, fromA)
			await Promise.all([waitExactlyOnce(a, fromA), waitExactlyOnce(b, fromA)])
			await postEntry(b, fromB)
			for (const page of [a, b]) {
				await waitExactlyOnce(page, fromB)
				const texts = await page.getByTestId('off-entries').locator('li').allTextContents()
				const indexB = texts.findIndex((text) => text.includes(fromB))
				const indexA = texts.findIndex((text) => text.includes(fromA))
				if (indexB < 0 || indexA < 0 || indexB >= indexA) throw new Error('replicas did not converge newest-first')
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
