import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	attach,
	detach,
	feedRows,
	openPhases,
	publishPair,
	waitForPair
} from './phases-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'phases cluster coverage requires two explicit replica targets')

async function openPair(browser) {
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	await Promise.all([
		openPhases(a, `${INSTANCE_A}/demos/phases`),
		openPhases(b, `${INSTANCE_B}/demos/phases`)
	])
	return { ctxA, ctxB, a, b }
}

test.describe('cluster: /demos/phases', () => {
	test('a pair published on replica A arrives with identical identity and ordering on replica B', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			const ids = await publishPair(pair.a)
			const [rowsA, rowsB] = await Promise.all([waitForPair(pair.a, ids), waitForPair(pair.b, ids)])
			expect(rowsA).toEqual(rowsB)
			expect(rowsA.map((row) => row?.half)).toEqual(['first', 'second'])
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('a detached replica catches up from shared storage when it explicitly reattaches', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			await detach(pair.b)
			const ids = await publishPair(pair.a)
			await waitForPair(pair.a, ids)
			await expect(pair.b.getByTestId('ph-feed')).toHaveCount(0)
			await attach(pair.b)
			await waitForPair(pair.b, ids)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('a failed batch on replica B leaves both replicas unchanged', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			const [beforeA, beforeB] = await Promise.all([feedRows(pair.a), feedRows(pair.b)])
			expect(beforeA).toEqual(beforeB)
			await pair.b.getByTestId('ph-publish-fail').click()
			await expect(pair.b.getByTestId('ph-batch-error')).toContainText('VALIDATION')
			await pair.a.waitForTimeout(1_500)
			expect(await feedRows(pair.a)).toEqual(beforeA)
			expect(await feedRows(pair.b)).toEqual(beforeB)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})
})
