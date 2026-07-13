import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/chat: two tabs forced onto DIFFERENT
// SO_REUSEPORT replicas (instance A vs instance B) against shared Redis +
// Postgres. This is the tier that catches the cluster-only bugs the
// single-instance suite cannot see (presence relay, pub/sub fan-out).
//
// Runs in the cluster tier (playwright project 'cluster', which the local
// harness starts with two instances and INSTANCE_B set). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

let roomSeq = 0
const freshRoom = (label) => `e2e-chat-${label}-${Date.now()}-${roomSeq++}`

async function presenceCount(page) {
	const raw = (await page.getByTestId('presence-count').textContent()) ?? ''
	return Number(raw.trim().split(' ')[0] || 0)
}

test.describe('cluster: /demos/chat cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('a message sent on replica A reaches a subscriber on replica B', async ({ browser }) => {
		test.setTimeout(60_000)
		const room = freshRoom('xrep-msg')
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/chat/${room}`)
			await b.goto(`${INSTANCE_B}/demos/chat/${room}`)
			await waitForWS(a)
			await waitForWS(b)

			const text = `xrep-${Date.now()}`
			await a.getByTestId('message-input').fill(text)
			await a.getByTestId('send-button').click()
			await expect(a.getByTestId('messages')).toContainText(text, { timeout: 15_000 })
			// The cross-replica pub/sub fan-out must deliver it to the B subscriber.
			await expect(b.getByTestId('messages')).toContainText(text, { timeout: 15_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('presence aggregates across replicas', async ({ browser }) => {
		test.setTimeout(60_000)
		const room = freshRoom('xrep-pres')
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/chat/${room}`)
			await b.goto(`${INSTANCE_B}/demos/chat/${room}`)
			await waitForWS(a)
			await waitForWS(b)
			// The cross-replica presence relay must aggregate both tabs so each
			// side reports two participants, not just its local one.
			await expect.poll(() => presenceCount(a), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
			await expect.poll(() => presenceCount(b), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('presence decrements across replicas when a remote participant leaves', async ({ browser }) => {
		test.setTimeout(90_000)
		const room = freshRoom('xrep-leave')
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`${INSTANCE_A}/demos/chat/${room}`)
			await b.goto(`${INSTANCE_B}/demos/chat/${room}`)
			await waitForWS(a)
			await waitForWS(b)
			await expect.poll(() => presenceCount(a), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

			// The B participant (on replica B) leaves. The cross-replica presence
			// relay must decrement A's roster back to just itself. This is the
			// exact leave-decrement path that leaks on the cluster (see the
			// live.room cross-replica presence relay bug), so this test is the
			// highest-value cluster assertion for chat.
			await ctxB.close()
			await expect.poll(() => presenceCount(a), { timeout: 45_000 }).toBe(1)
		} finally {
			await ctxA.close()
			await ctxB.close().catch(() => {})
		}
	})
})
