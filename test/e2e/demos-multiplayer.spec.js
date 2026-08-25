import { test, expect } from '@playwright/test'
import { alphaOfComputed, contrastOfComputed, expectTouchTarget, openTouchPage } from './helpers.js'
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

// Computed colours arrive as `rgb(r, g, b)` / `rgba(r, g, b, a)`. The shared
// helpers read what actually reached the screen, because what matters here is
// the rendered appearance and a class or an inline-style presence check is a
// proxy for it. The WCAG rule itself is exercised across the whole identity
// palette in test/unit/label-contrast.test.js.

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
		// The live value and the editor are labeled apart - the identical
		// sentence in both used to read as one confusing surface.
		await expect(page.getByTestId('mp-headline-live-label')).toContainText('Live value')
		await expect(page.getByTestId('mp-headline-editor-label')).toContainText('advisory lock (80 chars max)')
		await input.fill('   ')
		await expect(page.getByTestId('mp-headline-submit')).toBeDisabled()
		await input.blur()

		for (const token of REACTION_TOKENS) {
			await expect(page.getByTestId(`mp-react-${token}`)).toBeVisible()
			await expect(page.getByTestId(`mp-react-${token}`)).toHaveAttribute('aria-label', `React with ${token}`)
			await expect(page.getByTestId(`mp-react-${token}`)).toHaveClass(/btn-outline/)
		}
		// The reaction row names what tapping does; the canvas invites
		// fingers as well as pointers and dresses itself as interactive.
		await expect(page.getByText('React - it lands on the canvas for everyone:')).toBeVisible()
		await expect(page.getByTestId('mp-canvas')).toHaveClass(/cursor-crosshair/)
		// BOTH instructions, not only the canvas caption: the header intro is
		// the other half of that guidance and can revert on its own.
		await expect(page.getByTestId('mp-canvas-hint')).toContainText('drag a finger')
		await expect(page.getByTestId('mp-intro')).toContainText('drag a finger')

		// The crosshair class is one third of the affordance claim. The canvas
		// edge and the hint's legibility are the other two, and both can be
		// removed while a class assertion stays green.
		const canvas = await page.getByTestId('mp-canvas').evaluate((el) => {
			const style = getComputedStyle(el)
			return { width: parseFloat(style.borderTopWidth), color: style.borderTopColor }
		})
		expect(canvas.width, 'the canvas has no border, so its edge merges with the card').toBeGreaterThan(0)
		expect(
			alphaOfComputed(canvas.color),
			`the canvas border is ${canvas.color}, which paints no visible edge`
		).toBeGreaterThan(0.1)
		const hintOpacity = await page.getByTestId('mp-canvas-hint')
			.evaluate((el) => parseFloat(getComputedStyle(el).opacity))
		expect(hintOpacity, `the canvas hint renders at ${hintOpacity} opacity`).toBeGreaterThanOrEqual(0.5)

		// An inline `color:` declaration proves only that SOMETHING was set -
		// an always-white mapping satisfies it, which is the whole complaint.
		// Measure the contrast that actually reaches the screen. The palette is
		// checked exhaustively in test/unit/label-contrast.test.js; this proves
		// the rule survives the trip through the DOM for whichever colour this
		// visitor drew.
		const chip = await page.getByTestId('mp-roster').locator('li').first().evaluate((el) => {
			const style = getComputedStyle(el)
			return { color: style.color, background: style.backgroundColor }
		})
		expect(
			contrastOfComputed(chip.color, chip.background),
			`roster chip renders ${chip.color} on ${chip.background}, below WCAG AA for normal text`
		).toBeGreaterThanOrEqual(4.5)
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
			const fromA = `button-${Date.now()}`
			await inputA.fill(fromA)
			await expect(b.getByTestId('mp-typing')).toContainText(`${nameA} is typing...`, { timeout: 10_000 })
			// The typing echo also fires WHERE the typing happens - the
			// roster line sits a full viewport away on phones.
			await expect(b.getByTestId('mp-typing-inline')).toContainText(`${nameA} is typing...`)
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

	test('each emoji appends once while earlier nodes keep animating and expire independently', async ({ page }) => {
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

	// The peer wait's failure description is a triage instrument: it is read
	// only when the suite is already red, so nothing else in the suite can
	// exercise it and a wrong one would be believed. This forces it, and pins
	// WHICH side it blames - naming the wrong side sends the reader at the
	// wrong process, and an assertion on the word "asymmetric" alone passes
	// happily with the two sides swapped.
	test('a one-sided roster is reported as asymmetric against the side that lost the join', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openMultiplayer(a), openMultiplayer(b)])
			// Converge for real first, so what follows removes a peer that was
			// demonstrably delivered rather than one that never arrived.
			//
			// Retried once through a rejoin, and the reason is narrow. The room's
			// join race is an upstream defect at roughly 4% per pairing, and it
			// strikes at join time - so reopening both tabs is what recovers it,
			// not waiting longer. This test's subject is the failure DESCRIPTION,
			// not convergence, so a tier lost here buys no coverage and just adds
			// another draw to the merge gate's false-failure rate. The tests whose
			// subject IS presence deliberately do not do this: they are the ones
			// that should keep reporting the race.
			let names = await waitForPeers(a, b).catch(() => null)
			if (!names) {
				console.log('[mp-rejoin] first convergence lost to the upstream join race; reopening both tabs once')
				await Promise.all([openMultiplayer(a), openMultiplayer(b)])
				names = await waitForPeers(a, b)
			}
			const { nameA, nameB } = names

			// Blind A to B in the rendered roster only. B still sees A, which is
			// the asymmetric shape the description has to recognise.
			await a.evaluate(() => {
				for (const li of document.querySelectorAll('[data-testid="mp-roster-other"]')) li.textContent = 'Blinded Peer'
			})

			let message = null
			try {
				await waitForPeers(a, b, 2_000)
			} catch (error) {
				message = error.message
			}
			expect(message, 'describing the failure must not turn it into a pass').not.toBeNull()
			expect(message).toContain(`VERDICT: asymmetric. ${nameB} received the other join, ${nameA} never received it`)
			// The dumped rosters have to be checkable, not decorative. Assert the
			// two facts the verdict rests on and nothing more: this room is the
			// one fixed lounge every test in this file shares, so earlier
			// visitors can still be draining out of it and the entry LIST is not
			// a stable thing to pin.
			const lineFor = (side) => message.split('\n').find((l) => l.startsWith(`${side}: `))
			expect(lineFor('a')).toContain(`self="${nameA}"`)
			expect(lineFor('a'), 'the blinded side must be dumped without its peer').not.toContain(nameB)
			expect(lineFor('b')).toContain(`self="${nameB}"`)
			expect(lineFor('b'), 'the sighted side must be dumped still holding its peer').toContain(nameA)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('reaction buttons meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openMultiplayer(page)
			for (const token of REACTION_TOKENS) {
				await expectTouchTarget(page.getByTestId(`mp-react-${token}`))
			}
		} finally {
			await context.close()
		}
	})
})
