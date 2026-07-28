import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	activityTicker,
	boardCanvas,
	boardNotes,
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
	setNoteColor
} from './board-helpers.js'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'board cluster coverage requires two explicit replica targets')

test.describe('cluster: /board/[slug]', () => {
	test('notes, settings, cursor pixels, activity, and exact leave cleanup converge across replicas (RT-348)', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const ctxHome = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const home = await ctxHome.newPage()
		const title = `Board cluster ${Date.now()}`
		let path
		try {
			path = await createFreshBoard(a, title, INSTANCE_A)
			await Promise.all([
				openBoard(b, `${INSTANCE_B}${path}`),
				home.goto(`${INSTANCE_A}/`)
			])
			await waitForWS(home)
			await Promise.all([expectOnline(a, 2), expectOnline(b, 2), expectCardPresence(home, path, 2)])

			const note = await createNoteAt(a, 200, 190)
			await editNote(note, 'Cluster board note')
			await expect(noteWithText(b, 'Cluster board note')).toHaveCount(1, { timeout: 15_000 })
			await setNoteColor(noteWithText(b, 'Cluster board note'), '#e9d5ff')
			await expect.poll(async () => (await notePosition(noteWithText(a, 'Cluster board note'))).background).toMatch(/e9d5ff|rgb\(233,\s*213,\s*255\)/i)
			const before = await notePosition(noteWithText(a, 'Cluster board note'))
			await dragNote(b, noteWithText(b, 'Cluster board note'), 130, 80)
			await expect.poll(async () => (await notePosition(noteWithText(a, 'Cluster board note'))).left).toBeGreaterThan(before.left + 110)

			const renamed = `Cluster renamed ${Date.now()}`
			await b.locator('h1').dblclick()
			const input = b.locator('input.input-sm.w-36, input.input-sm.sm\\:w-48').first()
			await input.fill(renamed)
			await input.press('Enter')
			await expect(a.locator('h1')).toHaveText(renamed, { timeout: 15_000 })
			await a.getByLabel('Set background to #fdf4ff').click()
			for (const page of [a, b]) {
				await expect.poll(() => boardCanvas(page).evaluate((element) => element.style.background)).toMatch(/fdf4ff|rgb\(253,\s*244,\s*255\)/i)
			}

			await moveBoardCursor(a, 260, 210)
			await expect.poll(() => overlayHasInk(b, 260, 210), { timeout: 10_000 }).toBe(true)
			await deleteNote(noteWithText(a, 'Cluster board note'))
			await expect(boardNotes(b)).toHaveCount(0, { timeout: 15_000 })
			await expect(activityTicker(b)).toContainText('removed a note')

			await ctxB.close()
			await Promise.all([expectOnline(a, 1), expectCardPresence(home, path, 1)])
			await ctxA.close()
			await expectCardPresence(home, path, 0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close(), ctxHome.close()])
		}
	})
})
