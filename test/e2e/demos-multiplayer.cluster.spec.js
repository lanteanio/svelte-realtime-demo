import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	animationTime,
	cursorFor,
	expectNoMultiplayerErrors,
	isConnected,
	moveCursor,
	openMultiplayer,
	tapReaction,
	waitForPeers,
	waitForReactionCount
} from './multiplayer-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'multiplayer cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/multiplayer', () => {
	test('presence, typing, locks, headlines, and cursors converge in both directions', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([
				openMultiplayer(a, `${INSTANCE_A}/demos/multiplayer`),
				openMultiplayer(b, `${INSTANCE_B}/demos/multiplayer`)
			])
			const { nameA, nameB } = await waitForPeers(a, b)
			const inputA = a.getByTestId('mp-headline-input')
			const inputB = b.getByTestId('mp-headline-input')

			await inputA.focus()
			await inputA.fill(`cluster-a-${Date.now()}`)
			await expect(b.getByTestId('mp-lock-state')).toContainText(`Locked by ${nameA}.`, { timeout: 15_000 })
			await expect(b.getByTestId('mp-typing')).toContainText(`${nameA} is typing...`, { timeout: 15_000 })
			const fromA = await inputA.inputValue()
			await a.getByTestId('mp-headline-submit').click()
			await expect(b.getByTestId('mp-headline-display')).toHaveText(fromA, { timeout: 15_000 })
			await inputA.blur()

			await inputB.focus()
			await inputB.fill(`cluster-b-${Date.now()}`)
			await expect(a.getByTestId('mp-lock-state')).toContainText(`Locked by ${nameB}.`, { timeout: 15_000 })
			await expect(a.getByTestId('mp-typing')).toContainText(`${nameB} is typing...`, { timeout: 15_000 })
			const fromB = await inputB.inputValue()
			await inputB.press('Enter')
			await expect(a.getByTestId('mp-headline-display')).toHaveText(fromB, { timeout: 15_000 })
			await inputB.blur()

			await moveCursor(a, 0.2, 0.3)
			await expect(cursorFor(b, nameA)).toHaveAttribute('style', /left: 20%; top: 30%/, { timeout: 15_000 })
			await moveCursor(b, 0.8, 0.6)
			await expect(cursorFor(a, nameB)).toHaveAttribute('style', /left: 80%; top: 60%/, { timeout: 15_000 })
			await expectNoMultiplayerErrors(a, b)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('reaction append, node preservation, and independent expiry cross replicas (RT-347)', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([
				openMultiplayer(a, `${INSTANCE_A}/demos/multiplayer`),
				openMultiplayer(b, `${INSTANCE_B}/demos/multiplayer`)
			])
			await waitForPeers(a, b)
			await Promise.all([waitForReactionCount(a, 0), waitForReactionCount(b, 0)])

			await tapReaction(a, 'heart', 1)
			await waitForReactionCount(b, 1)
			const heartOnB = (await b.getByTestId('mp-reaction').elementHandles()).at(-1)
			await b.waitForTimeout(700)
			const before = await animationTime(heartOnB)
			await tapReaction(b, 'fire', 2)
			await waitForReactionCount(a, 2)
			expect(await isConnected(heartOnB)).toBe(true)
			expect(await animationTime(heartOnB)).toBeGreaterThanOrEqual(before)
			const fireOnB = (await b.getByTestId('mp-reaction').elementHandles()).at(-1)

			await expect.poll(() => isConnected(heartOnB), { timeout: 4_000 }).toBe(false)
			expect(await isConnected(fireOnB), 'the later cross-replica reaction must not expire with the first').toBe(true)
			await Promise.all([waitForReactionCount(a, 0), waitForReactionCount(b, 0)])
			await expectNoMultiplayerErrors(a, b)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
