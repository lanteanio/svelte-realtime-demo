import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	expectMembership,
	expectNoLobbyErrors,
	expectTableGone,
	freshTableId,
	joinById,
	joinFromRow,
	message,
	openLobbies,
	sendMessage
} from './lobbies-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'lobbies cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/lobbies', () => {
	test('one durable identity alternating replicas never inflates beyond 1/8', async ({ browser }) => {
		const ctx = await browser.newContext()
		const id = freshTableId()
		for (const origin of [INSTANCE_A, INSTANCE_B, INSTANCE_A, INSTANCE_B]) {
			const page = await ctx.newPage()
			try {
				await openLobbies(page, `${origin}/demos/lobbies`)
				await joinById(page, id)
				await expectMembership(page, id, 1)
				await page.getByTestId('lob-leave').click()
				await expectTableGone(page, id)
			} finally {
				await page.close()
			}
		}
		await ctx.close()
	})

	test('membership, messages, owner succession, and close converge across replicas', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const id = freshTableId()
		try {
			await Promise.all([
				openLobbies(a, `${INSTANCE_A}/demos/lobbies`),
				openLobbies(b, `${INSTANCE_B}/demos/lobbies`)
			])
			await joinById(a, id)
			await joinFromRow(b, id)
			await Promise.all([expectMembership(a, id, 2), expectMembership(b, id, 2)])
			const fromA = `cluster-a-${Date.now()}`
			const fromB = `cluster-b-${Date.now()}`
			await sendMessage(a, fromA)
			await Promise.all([expect(message(a, fromA)).toHaveCount(1), expect(message(b, fromA)).toHaveCount(1)])
			await sendMessage(b, fromB, 'enter')
			await Promise.all([expect(message(a, fromB)).toHaveCount(1), expect(message(b, fromB)).toHaveCount(1)])

			await expect(a.getByTestId('lob-close')).toBeEnabled()
			await expect(b.getByTestId('lob-close')).toBeDisabled()
			await a.getByTestId('lob-leave').click()
			await expectMembership(b, id, 1)
			await expect(b.getByTestId('lob-owner-badge')).toHaveText('you own this table', { timeout: 15_000 })
			await b.getByTestId('lob-close').click()
			await expect(message(b, fromA)).toHaveCount(0, { timeout: 10_000 })
			await expect(message(b, fromB)).toHaveCount(0, { timeout: 10_000 })
			await expectNoLobbyErrors(a, b)
		} finally {
			await b.getByTestId('lob-leave').click({ timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
