import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	dlqCount,
	openOutbound,
	placeOrder,
	receiptRows,
	replayOne,
	waitForDlq,
	waitForReceipts
} from './outbound-webhooks-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'outbound-webhooks cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

let sharedFailId

async function openPair(browser) {
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	await Promise.all([
		openOutbound(a, `${INSTANCE_A}/demos/outbound-webhooks`),
		openOutbound(b, `${INSTANCE_B}/demos/outbound-webhooks`)
	])
	return { ctxA, ctxB, a, b }
}

test.describe('cluster: /demos/outbound-webhooks', () => {
	test('orders from either replica produce shared signed receipts and one shared DLQ record', async ({ browser }) => {
		test.setTimeout(45_000)
		const pair = await openPair(browser)
		try {
			const okId = await placeOrder(pair.a, 'ok')
			const okReceipts = await waitForReceipts(pair.b, okId)
			expect(okReceipts.every((receipt) => receipt.sigValid && /\b200\b/.test(receipt.text))).toBe(true)

			sharedFailId = await placeOrder(pair.b, 'fail')
			await Promise.all([waitForDlq(pair.a, sharedFailId), waitForDlq(pair.b, sharedFailId)])
			const [aReceipts, bReceipts] = await Promise.all([
				waitForReceipts(pair.a, sharedFailId, 3),
				waitForReceipts(pair.b, sharedFailId, 3)
			])
			expect(aReceipts).toEqual(bReceipts)
			expect(await dlqCount(pair.a)).toBe(await dlqCount(pair.b))
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('per-record replay on replica B increases receipts and re-dead-letters on both replicas', async ({ browser }) => {
		test.setTimeout(45_000)
		expect(sharedFailId).toBeTruthy()
		const pair = await openPair(browser)
		try {
			await Promise.all([waitForDlq(pair.a, sharedFailId), waitForDlq(pair.b, sharedFailId)])
			const before = await receiptRows(pair.a, sharedFailId).count()
			const replay = await replayOne(pair.b, sharedFailId)
			expect(replay).toEqual({ replayed: 0, total: 1 })
			await expect.poll(() => receiptRows(pair.a, sharedFailId).count(), { timeout: 25_000 })
				.toBeGreaterThan(before)
			await Promise.all([waitForDlq(pair.a, sharedFailId), waitForDlq(pair.b, sharedFailId)])
			expect(await dlqCount(pair.a)).toBe(await dlqCount(pair.b))
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})
})
