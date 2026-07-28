import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	auditTraces,
	displayedIdentity,
	forget,
	leaveTraces,
	openForget,
	traceResult
} from './forget-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'forget cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function sameIdentityOnTwoReplicas(browser) {
	const context = await browser.newContext({ baseURL: INSTANCE_A })
	const a = await context.newPage()
	await openForget(a, `${INSTANCE_A}/demos/forget`)
	const b = await context.newPage()
	await openForget(b, `${INSTANCE_B}/demos/forget`)
	expect(await displayedIdentity(b)).toBe(await displayedIdentity(a))
	return { context, a, b }
}

test.describe('cluster: /demos/forget', () => {
	test('app traces converge across replicas; erasure on B clears A and both remain usable', async ({ browser }) => {
		const pair = await sameIdentityOnTwoReplicas(browser)
		try {
			await forget(pair.a)
			const fromA = await leaveTraces(pair.a)
			expect(fromA.total).toBe(3)
			await auditTraces(pair.b, 3)
			const fromB = await leaveTraces(pair.b)
			expect(fromB.total).toBe(6)
			await auditTraces(pair.a, 6)

			const result = await forget(pair.b, 6)
			expect(result.counts.appDemoLog).toBe(6)
			expect(result.counts.push + result.counts.presence + result.counts.durable).toBeGreaterThan(0)
			await auditTraces(pair.a, 0)
			await expect(pair.a.locator('.text-success').first()).toBeVisible()
			await expect(pair.b.locator('.text-success').first()).toBeVisible()

			await pair.a.getByTestId('fg-leave-traces').click()
			await auditTraces(pair.b, 3)
			const fresh = await traceResult(pair.a)
			expect(fresh.total).toBe(3)
		} finally {
			await forget(pair.a, 3).catch(() => {})
			await pair.context.close()
		}
	})

	test('the idempotent draft is shared before erasure and recomputed on the other replica afterwards', async ({ browser }) => {
		const pair = await sameIdentityOnTwoReplicas(browser)
		try {
			await forget(pair.a)
			const first = await leaveTraces(pair.a)
			await new Promise((resolve) => setTimeout(resolve, 1_100))
			const cached = await leaveTraces(pair.b)
			expect(cached.draft).toBe(first.draft)
			expect(cached.total).toBe(6)

			await forget(pair.b, 6)
			await new Promise((resolve) => setTimeout(resolve, 1_100))
			await pair.a.getByTestId('fg-leave-traces').click()
			await auditTraces(pair.b, 3)
			const recomputed = await traceResult(pair.a)
			expect(recomputed.total).toBe(3)
			expect(recomputed.draft).not.toBe(first.draft)
		} finally {
			await forget(pair.a, 3).catch(() => {})
			await pair.context.close()
		}
	})
})
