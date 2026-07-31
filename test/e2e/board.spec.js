import { test, expect } from '@playwright/test'
import {
	activityTicker,
	boardCanvas,
	boardNotes,
	clickFabAction,
	createFreshBoard,
	createNoteAt,
	deleteNote,
	dragNote,
	editNote,
	expectCardPresence,
	expectOnline,
	moveBoardCursor,
	notePosition,
	noteWithText,
	openBoard,
	overlayHasInk,
	positions,
	setNoteColor
} from './board-helpers.js'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/board/[slug]', () => {
	test('fresh board renders every header, canvas, presence, activity, and FAB control', async ({ page }) => {
		const title = `Board surface ${Date.now()}`
		await createFreshBoard(page, title)
		await expect(page.locator('h1')).toHaveText(title)
		await expectOnline(page, 1)
		await expect(boardNotes(page)).toHaveCount(0)
		await expect(page.getByText(/Double-(click|tap) anywhere to add a note/)).toBeVisible()
		await expect(activityTicker(page)).toContainText('No activity yet')
		await expect(page.getByLabel(/Set background to #/)).toHaveCount(6)
		await expect(page.locator('.fab-trigger')).toBeVisible()

		await page.locator('.fab-trigger').focus()
		for (const label of ['Tidy z-order', 'Re-arrange by color', 'Shuffle notes', 'Group by author']) {
			await expect(page.locator(`[data-tip="${label}"] button`)).toBeVisible()
		}
		await page.locator('.fab-close button').click()
		await expect.poll(() => page.locator('.fab-close button').evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(1)

		await page.locator('a[href="/"]').first().click()
		await page.waitForURL(/\/$/)
	})

	test('note CRUD, color, focus z-order, drag, activity, and persistence have real outcomes', async ({ page }) => {
		await createFreshBoard(page, `Board CRUD ${Date.now()}`)
		const alpha = await createNoteAt(page, 120, 150)
		await expect(alpha).toContainText('Double-click to edit')
		await expect(alpha.locator('.text-xs.opacity-40')).not.toHaveText('')
		await expect(activityTicker(page)).toContainText('added a note')
		await editNote(alpha, 'Alpha note', 'escape')
		await expect(activityTicker(page)).toContainText('edited a note')
		await setNoteColor(alpha, '#bbf7d0')
		await expect(activityTicker(page)).toContainText('recolored a note')

		const beta = await createNoteAt(page, 480, 170)
		await editNote(beta, 'Beta note')
		const betaZ = (await notePosition(beta)).z
		await alpha.click({ force: true })
		await expect.poll(async () => (await notePosition(alpha)).z).toBeGreaterThan(betaZ)

		const beforeDrag = await notePosition(alpha)
		const afterDrag = await dragNote(page, alpha, 140, 90)
		expect(afterDrag.left).toBeGreaterThan(beforeDrag.left + 120)
		expect(afterDrag.top).toBeGreaterThan(beforeDrag.top + 70)

		await page.reload()
		await waitForWS(page)
		await expect(noteWithText(page, 'Alpha note')).toHaveCount(1, { timeout: 15_000 })
		await expect(noteWithText(page, 'Beta note')).toHaveCount(1)
		const persisted = await notePosition(noteWithText(page, 'Alpha note'))
		expect(persisted.left).toBe(afterDrag.left)
		expect(persisted.top).toBe(afterDrag.top)
		expect(persisted.background).toMatch(/bbf7d0|rgb\(187,\s*247,\s*208\)/i)

		await deleteNote(noteWithText(page, 'Beta note'))
		await expect(boardNotes(page)).toHaveCount(1)
		await expect(activityTicker(page)).toContainText('removed a note')
	})

	test('Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, textarea undo isolation, and delete restoration all work', async ({ page }) => {
		await createFreshBoard(page, `Board history ${Date.now()}`)
		await createNoteAt(page, 240, 220)
		await expect(boardNotes(page)).toHaveCount(1)
		await page.keyboard.press('Control+z')
		await expect(boardNotes(page)).toHaveCount(0, { timeout: 10_000 })
		await page.keyboard.press('Control+Shift+z')
		await expect(boardNotes(page)).toHaveCount(1, { timeout: 10_000 })
		await page.keyboard.press('Control+z')
		await expect(boardNotes(page)).toHaveCount(0, { timeout: 10_000 })
		await page.keyboard.press('Control+y')
		await expect(boardNotes(page)).toHaveCount(1, { timeout: 10_000 })

		const note = boardNotes(page).first()
		await note.dblclick({ force: true })
		const textarea = note.locator('textarea')
		await textarea.fill('History draft')
		await textarea.press('Control+z')
		await expect(boardNotes(page)).toHaveCount(1)
		await textarea.press('Escape')
		await expect(note.locator('textarea')).toHaveCount(0)

		await deleteNote(note)
		await expect(boardNotes(page)).toHaveCount(0)
		await page.keyboard.press('Control+z')
		await expect(boardNotes(page)).toHaveCount(1, { timeout: 10_000 })
	})

	test('all four arrangement actions produce bounded deterministic layouts and the menu closes', async ({ page }) => {
		await createFreshBoard(page, `Board arrange ${Date.now()}`)
		const a = await createNoteAt(page, 100, 120)
		await editNote(a, 'Arrange A')
		const b = await createNoteAt(page, 500, 120)
		await editNote(b, 'Arrange B')
		const c = await createNoteAt(page, 100, 400)
		await editNote(c, 'Arrange C')
		await setNoteColor(b, '#bbf7d0')
		await setNoteColor(c, '#bbf7d0')

		await clickFabAction(page, 'Re-arrange by color')
		await expect.poll(() => positions(page)).toEqual([
			{ left: 40, top: 40, z: 0 },
			{ left: 300, top: 40, z: 1 },
			{ left: 304, top: 75, z: 2 }
		])
		await expect(activityTicker(page)).toContainText('rearranged the board')

		await noteWithText(page, 'Arrange C').click({ force: true })
		await expect.poll(async () => (await notePosition(noteWithText(page, 'Arrange C'))).z).toBeGreaterThan(2)
		await clickFabAction(page, 'Tidy z-order')
		await expect.poll(() => positions(page)).toEqual([
			{ left: 40, top: 40, z: 0 },
			{ left: 300, top: 40, z: 1 },
			{ left: 304, top: 75, z: 2 }
		])
		await expect(activityTicker(page)).toContainText('tidied the board')

		const beforeShuffle = await positions(page)
		await clickFabAction(page, 'Shuffle notes')
		await expect.poll(async () => JSON.stringify(await positions(page))).not.toBe(JSON.stringify(beforeShuffle))
		const shuffled = await positions(page)
		for (const [index, position] of shuffled.entries()) {
			expect(position.left).toBeGreaterThanOrEqual(40)
			expect(position.left).toBeLessThan(760)
			expect(position.top).toBeGreaterThanOrEqual(40)
			expect(position.top).toBeLessThan(560)
			expect(position.z).toBe(index)
		}
		await expect(activityTicker(page)).toContainText('shuffled the board')

		await clickFabAction(page, 'Group by author')
		await expect.poll(() => positions(page)).toEqual([
			{ left: 40, top: 40, z: 0 },
			{ left: 44, top: 75, z: 1 },
			{ left: 48, top: 110, z: 2 }
		])
		await expect(activityTicker(page)).toContainText('grouped notes by author')
		await page.locator('.fab-trigger').focus()
		await page.locator('.fab-close button').click()
		await expect.poll(() => page.locator('.fab-close button').evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeLessThan(1)
	})

	test('two tabs sync notes/settings/cursors and home presence returns exactly to zero (RT-348)', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const ctxHome = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const home = await ctxHome.newPage()
		const title = `Board realtime ${Date.now()}`
		let path
		try {
			path = await createFreshBoard(a, title)
			await Promise.all([openBoard(b, path), home.goto('/')])
			await waitForWS(home)
			await Promise.all([expectOnline(a, 2), expectOnline(b, 2), expectCardPresence(home, path, 2)])

			const noteA = await createNoteAt(a, 180, 180)
			await editNote(noteA, 'Shared note')
			await expect(noteWithText(b, 'Shared note')).toHaveCount(1, { timeout: 15_000 })
			await editNote(boardNotes(b).first(), 'Edited remotely')
			await expect(noteWithText(a, 'Edited remotely')).toHaveCount(1, { timeout: 15_000 })
			await setNoteColor(noteWithText(b, 'Edited remotely'), '#bfdbfe')
			await expect.poll(async () => (await notePosition(noteWithText(a, 'Edited remotely'))).background).toMatch(/bfdbfe|rgb\(191,\s*219,\s*254\)/i)

			const beforeRemoteDrag = await notePosition(noteWithText(a, 'Edited remotely'))
			await dragNote(b, noteWithText(b, 'Edited remotely'), 120, 70)
			await expect.poll(async () => (await notePosition(noteWithText(a, 'Edited remotely'))).left).toBeGreaterThan(beforeRemoteDrag.left + 100)

			const renamed = `Renamed realtime ${Date.now()}`
			await a.locator('h1').dblclick()
			const titleInput = a.locator('input.input-sm.w-36, input.input-sm.sm\\:w-48').first()
			await titleInput.fill(renamed)
			await titleInput.press('Enter')
			await Promise.all([
				expect(a.locator('h1')).toHaveText(renamed),
				expect(b.locator('h1')).toHaveText(renamed, { timeout: 15_000 })
			])
			await b.getByLabel('Set background to #eff6ff').click()
			for (const page of [a, b]) {
				await expect.poll(() => boardCanvas(page).evaluate((element) => element.style.background)).toMatch(/eff6ff|rgb\(239,\s*246,\s*255\)/i)
			}

			await moveBoardCursor(a, 220, 180)
			await expect.poll(() => overlayHasInk(b, 220, 180), { timeout: 10_000 }).toBe(true)
			await deleteNote(noteWithText(b, 'Edited remotely'))
			await expect(boardNotes(a)).toHaveCount(0, { timeout: 15_000 })
			await expect(activityTicker(a)).toContainText('removed a note')

			await ctxB.close()
			await Promise.all([expectOnline(a, 1), expectCardPresence(home, path, 1)])
			await ctxA.close()
			await expectCardPresence(home, path, 0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close(), ctxHome.close()])
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await createFreshBoard(page, `Board touch ${Date.now()}`)
			// Low enough on the canvas that the upward-growing color grid stays unclipped.
			const note = await createNoteAt(page, 120, 300)
			await expectTouchTarget(note.getByLabel('Pick color'))
			await expectTouchTarget(note.getByLabel('Delete note'))
			await note.getByLabel('Pick color').tap()
			const dots = note.getByLabel(/Set color to #/)
			await expect(dots).toHaveCount(6)
			for (const dot of await dots.all()) await expectTouchTarget(dot)
			// The background swatches only exist from the sm breakpoint up: re-rung
			// as a coarse-pointer tablet and measure all six.
			await page.setViewportSize({ width: 834, height: 1194 })
			const swatches = page.getByLabel(/Set background to #/)
			await expect(swatches).toHaveCount(6)
			for (const swatch of await swatches.all()) await expectTouchTarget(swatch)
		} finally {
			await context.close()
		}
	})
})
