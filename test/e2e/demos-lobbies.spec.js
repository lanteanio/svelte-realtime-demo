import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage } from './helpers.js'
import {
	expectMembership,
	expectNoLobbyErrors,
	expectTableGone,
	freshTableId,
	joinByCode,
	joinById,
	joinFromRow,
	message,
	openLobbies,
	roomRow,
	sendMessage,
	shareCode
} from './lobbies-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/lobbies', () => {
	test('renders every control and enforces id/code constraints without joining', async ({ page }) => {
		await openLobbies(page)
		await expect(page.getByLabel('Table number')).toBeVisible()
		await expect(page.getByLabel('Share code')).toBeVisible()
		await expect(page.getByTestId('lob-new-id')).toHaveAttribute('placeholder', 'Number')
		await expect(page.getByTestId('lob-code-input')).toHaveAttribute('placeholder', 'Code')
		await expect(page.getByTestId('lob-code-input')).toHaveAttribute('maxlength', '6')
		await expect(page.getByTestId('lob-random')).toHaveText('random')
		await expect(page.getByTestId('lob-create')).toHaveText('Open / join')
		await expect(page.getByTestId('lob-code-join')).toHaveText('Join by code')
		await expect(page.getByTestId('lob-rooms')).toContainText(/No active tables|Table/)

		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-error')).toHaveText('Table numbers are numeric (1-9 digits).')
		await page.getByTestId('lob-new-id').fill('not-a-table')
		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-error')).toHaveText('Table numbers are numeric (1-9 digits).')
		await page.getByTestId('lob-new-id').fill('1234567890')
		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-error')).toHaveText('Table numbers are numeric (1-9 digits).')

		await page.getByTestId('lob-random').click()
		await expect(page.getByTestId('lob-new-id')).toHaveValue(/^\d{1,6}$/)
		await page.getByTestId('lob-code-input').fill('!!!!!!')
		await page.getByTestId('lob-code-join').click()
		await expect(page.getByTestId('lob-code-error')).toHaveText('That code does not decode.', { timeout: 10_000 })
		await expect(page.getByTestId('lob-table-title')).toHaveCount(0)
		await expect(page.getByRole('link', { name: 'lobbies.js' })).toHaveAttribute(
			'href',
			'https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/lobbies.js'
		)
	})

	test('persistent field labels and controls remain intact at every audited narrow rung', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await openLobbies(page)

		for (const viewport of [
			{ width: 320, height: 568 },
			{ width: 360, height: 640 },
			{ width: 768, height: 1024 },
			{ width: 844, height: 390 }
		]) {
			await page.setViewportSize(viewport)
			for (const name of ['Table number', 'Share code']) {
				const label = page.getByText(name, { exact: true })
				const input = page.getByLabel(name)
				await expect(label).toBeVisible()
				await expect(input).toBeVisible()
				const geometry = await input.evaluate((node) => {
					const box = node.getBoundingClientRect()
					const formBox = node.closest('form')?.getBoundingClientRect()
					return {
						width: box.width,
						insideForm: Boolean(formBox && box.left >= formBox.left && box.right <= formBox.right + 0.5)
					}
				})
				expect(geometry.width, `${name} at ${viewport.width}px`).toBeGreaterThanOrEqual(96)
				expect(geometry.insideForm, `${name} containment at ${viewport.width}px`).toBe(true)
			}
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
			expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(1)
		}
	})

	test('solo leave/rejoin cycles stay exactly 1/8 and code rejoin creates no ghosts', async ({ page }) => {
		await openLobbies(page)
		const id = freshTableId()
		let code
		for (let cycle = 0; cycle < 4; cycle += 1) {
			await joinById(page, id)
			await expectMembership(page, id, 1)
			await expect(page.getByTestId('lob-owner-badge')).toHaveText('you own this table')
			code ??= await shareCode(page, id)
			await page.getByTestId('lob-leave').click()
			await expectTableGone(page, id)
		}

		await joinByCode(page, code, id)
		await expectMembership(page, id, 1)
		await expect(page.getByTestId('lob-owner-badge')).toHaveText('you own this table')
		await page.getByTestId('lob-leave').click()
		await expectTableGone(page, id)
	})

	test('active-row join has exact presence and late-join/live feed semantics in both directions', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const id = freshTableId()
		try {
			await Promise.all([openLobbies(a), openLobbies(b)])
			await joinById(a, id)
			await expectMembership(a, id, 1)
			const beforeJoin = `before-${Date.now()}`
			await sendMessage(a, beforeJoin)
			await expect(message(a, beforeJoin)).toHaveCount(1)

			await joinFromRow(b, id)
			await Promise.all([expectMembership(a, id, 2), expectMembership(b, id, 2)])
			await expect(message(b, beforeJoin)).toHaveCount(0)
			await expect(b.getByTestId('lob-feed')).toContainText('No messages yet')

			const fromA = `from-a-${Date.now()}`
			await sendMessage(a, fromA, 'button')
			await Promise.all([expect(message(a, fromA)).toHaveCount(1), expect(message(b, fromA)).toHaveCount(1)])
			const fromB = `from-b-${Date.now()}`
			await sendMessage(b, fromB, 'enter')
			await Promise.all([expect(message(a, fromB)).toHaveCount(1), expect(message(b, fromB)).toHaveCount(1)])
			// The all-route name sweep cannot reach this field: it only exists once
			// a lobby has been joined, and no URL gets you there. So the policy is
			// enforced here, where the join has already happened - otherwise this
			// control's placeholder is its only description and nothing notices.
			await expect(
				a.getByTestId('lob-composer-input'),
				'the composer needs a name of its own; its placeholder disappears as soon as you type'
			).toHaveAttribute('aria-label', 'Message')
			await expect(a.getByTestId('lob-composer-input')).toHaveAttribute('maxlength', '140')
			await a.getByTestId('lob-composer-input').fill('   ')
			await expect(a.getByTestId('lob-send')).toBeDisabled()
			await a.getByTestId('lob-composer-input').fill('')

			await ctxB.close()
			await expectMembership(a, id, 1)
			await expectNoLobbyErrors(a)
		} finally {
			await a.getByTestId('lob-leave').click({ timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('owner-only close is gated, succession is deterministic, and the owner clears every feed', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const id = freshTableId()
		try {
			await Promise.all([openLobbies(a), openLobbies(b)])
			await joinById(a, id)
			await joinFromRow(b, id)
			await expect(a.getByTestId('lob-owner-badge')).toHaveText('you own this table', { timeout: 10_000 })
			await expect(a.getByTestId('lob-close')).toBeEnabled()
			await expect(b.getByTestId('lob-owner-badge')).toContainText('owned by')
			await expect(b.getByTestId('lob-close')).toBeDisabled()

			const retained = `succession-${Date.now()}`
			await sendMessage(b, retained)
			await Promise.all([expect(message(a, retained)).toHaveCount(1), expect(message(b, retained)).toHaveCount(1)])
			await a.getByTestId('lob-leave').click()
			await expect(b.getByTestId('lob-owner-badge')).toHaveText('you own this table', { timeout: 15_000 })
			await expect(b.getByTestId('lob-close')).toBeEnabled()

			await joinFromRow(a, id)
			await expect(a.getByTestId('lob-owner-badge')).toContainText('owned by')
			await expect(a.getByTestId('lob-close')).toBeDisabled()
			const toClear = `clear-${Date.now()}`
			await sendMessage(a, toClear)
			await Promise.all([expect(message(a, toClear)).toHaveCount(1), expect(message(b, toClear)).toHaveCount(1)])
			await b.getByTestId('lob-close').click()
			for (const page of [a, b]) {
				await expect(message(page, retained)).toHaveCount(0, { timeout: 10_000 })
				await expect(message(page, toClear)).toHaveCount(0, { timeout: 10_000 })
				await expect(page.getByTestId('lob-feed')).toContainText('No messages yet')
			}
			await expectNoLobbyErrors(a, b)
		} finally {
			await Promise.allSettled([
				a.getByTestId('lob-leave').click({ timeout: 2_000 }).catch(() => {}),
				b.getByTestId('lob-leave').click({ timeout: 2_000 }).catch(() => {})
			])
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		const id = freshTableId()
		try {
			await openLobbies(page)
			await joinById(page, id)
			// A row exists now: its btn-xs join control and the joined-table
			// leave control are the near-the-floor targets the audit flagged.
			await expectTouchTarget(roomRow(page, id).getByTestId(`lob-room-join-${id}`))
			await expectTouchTarget(page.getByTestId('lob-leave'))
			// Flex-grown form submit: height is the constrained axis.
			await expectTouchTarget(page.getByTestId('lob-create'), { minWidth: 0 })
		} finally {
			await page.getByTestId('lob-leave').click({ timeout: 2_000 }).catch(() => {})
			await context.close()
		}
	})
})
