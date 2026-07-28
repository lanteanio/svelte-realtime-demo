import { test, expect } from '@playwright/test'
import {
	REACTION_TOKENS,
	animationTime,
	cursorFor,
	expectNoMultiplayerErrors,
	isConnected,
	moveCursor,
	openMultiplayer,
	participantName,
	tapReaction,
	waitForPeers,
	waitForReactionCount
} from './multiplayer-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/multiplayer', () => {
	test('renders every shared surface, control constraint, disclosure, and source link', async ({ page }) => {
		await openMultiplayer(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Multiplayer lounge: one room, every surface')
		await expect(page.getByTestId('mp-canvas')).toBeVisible()
		await expect(page.getByTestId('mp-roster')).toContainText('(you)')
		await expect(page.getByTestId('mp-typing')).toHaveText('Nobody is typing.')
		await expect(page.getByTestId('mp-lock-state')).toHaveText('Lock free.')

		const input = page.getByTestId('mp-headline-input')
		await expect(input).toHaveAttribute('maxlength', '80')
		await expect(input).toHaveAttribute('placeholder', 'Rewrite the headline (max 80 chars)...')
		await input.fill('   ')
		await expect(page.getByTestId('mp-headline-submit')).toBeDisabled()
		await input.blur()

		for (const token of REACTION_TOKENS) {
			await expect(page.getByTestId(`mp-react-${token}`)).toBeVisible()
			await expect(page.getByTestId(`mp-react-${token}`)).toHaveAttribute('aria-label', `React with ${token}`)
		}
		await expect(page.getByRole('link', { name: 'multiplayer.js' })).toHaveAttribute(
			'href',
			'https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/multiplayer.js'
		)
		await expectNoMultiplayerErrors(page)
	})

	test('two visitors share presence, typing, advisory locks, and button/Enter headline edits both ways', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openMultiplayer(a), openMultiplayer(b)])
			const { nameA, nameB } = await waitForPeers(a, b)
			const inputA = a.getByTestId('mp-headline-input')
			const inputB = b.getByTestId('mp-headline-input')

			await inputA.focus()
			await expect(a.getByTestId('mp-lock-state')).toHaveText('You hold the lock.', { timeout: 10_000 })
			await expect(b.getByTestId('mp-lock-state')).toContainText(`Locked by ${nameA}.`, { timeout: 10_000 })
			await expect(inputB).toBeDisabled()
			await expect(inputB).toHaveAttribute('placeholder', `Locked by ${nameA}`)
			const fromA = `button-${Date.now()}`
			await inputA.fill(fromA)
			await expect(b.getByTestId('mp-typing')).toContainText(`${nameA} is typing...`, { timeout: 10_000 })
			await a.getByTestId('mp-headline-submit').click()
			await Promise.all([
				expect(a.getByTestId('mp-headline-display')).toHaveText(fromA),
				expect(b.getByTestId('mp-headline-display')).toHaveText(fromA)
			])
			await inputA.blur()
			await expect(b.getByTestId('mp-lock-state')).toHaveText('Lock free.', { timeout: 10_000 })
			await expect(inputB).toBeEnabled()
			await expect(b.getByTestId('mp-typing')).toHaveText('Nobody is typing.', { timeout: 10_000 })

			await inputB.focus()
			await expect(a.getByTestId('mp-lock-state')).toContainText(`Locked by ${nameB}.`, { timeout: 10_000 })
			const fromB = `enter-${Date.now()}`
			await inputB.fill(fromB)
			await expect(a.getByTestId('mp-typing')).toContainText(`${nameB} is typing...`, { timeout: 10_000 })
			await inputB.press('Enter')
			await Promise.all([
				expect(a.getByTestId('mp-headline-display')).toHaveText(fromB),
				expect(b.getByTestId('mp-headline-display')).toHaveText(fromB)
			])
			await inputB.blur()
			await expect(a.getByTestId('mp-lock-state')).toHaveText('Lock free.', { timeout: 10_000 })
			await expectNoMultiplayerErrors(a, b)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('normalized cursors propagate bidirectionally and a departing visitor is removed', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openMultiplayer(a), openMultiplayer(b)])
			const { nameA, nameB } = await waitForPeers(a, b)
			await moveCursor(a, 0.25, 0.35)
			const cursorAOnB = cursorFor(b, nameA)
			await expect(cursorAOnB).toBeVisible({ timeout: 10_000 })
			await expect(cursorAOnB).toHaveAttribute('style', /left: 25%; top: 35%/)

			await moveCursor(b, 0.7, 0.65)
			const cursorBOnA = cursorFor(a, nameB)
			await expect(cursorBOnA).toBeVisible({ timeout: 10_000 })
			await expect(cursorBOnA).toHaveAttribute('style', /left: 70%; top: 65%/)
			await ctxB.close()
			await expect(a.getByTestId('mp-roster-other').filter({ hasText: nameB })).toHaveCount(0, { timeout: 15_000 })
			await expect(cursorFor(a, nameB)).toHaveCount(0, { timeout: 15_000 })
			await expectNoMultiplayerErrors(a)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('each emoji appends once while earlier nodes keep animating and expire independently (RT-347)', async ({ page }) => {
		await openMultiplayer(page)
		await waitForReactionCount(page, 0)

		const heart = await tapReaction(page, 'heart', 1)
		await page.waitForTimeout(700)
		const heartBefore = await animationTime(heart)
		expect(heartBefore).toBeGreaterThan(300)

		const fire = await tapReaction(page, 'fire', 2)
		expect(await isConnected(heart), 'the first reaction node must survive an append').toBe(true)
		expect(await animationTime(heart), 'the first animation must not rewind to its spawn').toBeGreaterThanOrEqual(heartBefore)
		const clap = await tapReaction(page, 'clap', 3)
		const star = await tapReaction(page, 'star', 4)
		for (const handle of [fire, clap, star]) expect(await isConnected(handle)).toBe(true)

		await expect.poll(() => isConnected(heart), { timeout: 4_000 }).toBe(false)
		expect(await isConnected(fire), 'the later reaction must remain while the earlier one is pruned').toBe(true)
		await waitForReactionCount(page, 0)
		await expectNoMultiplayerErrors(page)
	})
})
