import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'
import { createNote, getNotes, waitForBoardReady, waitForWS } from './helpers.js'
import { clickFabAction, createFreshBoard, positions, editNote, openBoard } from './board-helpers.js'
import { callRpc } from './ws-rpc.js'
import { toWebSocketURL, toHandshakeOrigin } from '../../scripts/test-target.mjs'

async function twoNotes(page) {
	await createFreshBoard(page, `Deletion undo ${Date.now()}`)
	await createNote(page, 200, 260)
	await createNote(page, 520, 260)
	await expect(getNotes(page)).toHaveCount(2)
	await editNote(getNotes(page).first(), 'Restore this note')
}

async function deleteFirst(page) {
	const note = getNotes(page).filter({ hasText: 'Restore this note' })
	await note.hover({ force: true })
	await note.getByLabel('Delete note').click({ force: true })
	await expect(getNotes(page)).toHaveCount(1)
	await expect(page.getByTestId('board-undo')).toBeEnabled()
}

async function socketFor(page) {
	const address = toWebSocketURL(new URL(page.url()).origin)
	const cookies = await page.context().cookies()
	const socket = new WebSocket(address, {
		origin: toHandshakeOrigin(address),
		headers: { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') }
	})
	await new Promise((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	return socket
}

test.describe('Collaborative deletion undo', () => {
	test('Undo publishes the restored note to another visitor and survives reload', async ({ page, browser }) => {
		await twoNotes(page)
		const otherContext = await browser.newContext()
		try {
			const other = await otherContext.newPage()
			await openBoard(other, page.url())
			await expect(getNotes(other)).toHaveCount(2)
			await deleteFirst(page)
			await expect(getNotes(other)).toHaveCount(1)
			await expect(other.getByTestId('board-undo')).toHaveCount(0)
			await page.getByTestId('board-undo').click()
			for (const visitor of [page, other]) {
				await expect(getNotes(visitor)).toHaveCount(2)
				await expect(getNotes(visitor).filter({ hasText: 'Restore this note' })).toHaveCount(1)
				await visitor.reload()
				await waitForWS(visitor)
				await waitForBoardReady(visitor)
				await expect(getNotes(visitor)).toHaveCount(2)
				await expect(getNotes(visitor).filter({ hasText: 'Restore this note' })).toHaveCount(1)
			}
			await expect(page.getByTestId('board-undo')).toHaveCount(0)
		} finally { await otherContext.close() }
	})

	test('a deletion receipt survives reload and Ctrl+Z restores it', async ({ page }) => {
		await twoNotes(page)
		await deleteFirst(page)
		await page.reload()
		await waitForWS(page)
		await waitForBoardReady(page)
		await expect(getNotes(page)).toHaveCount(1)
		await expect(page.getByTestId('board-undo')).toBeEnabled()
		await page.locator('body').click({ position: { x: 5, y: 5 } })
		await page.keyboard.press('Control+z')
		await expect(getNotes(page)).toHaveCount(2)
		await expect(page.getByTestId('board-note-announcement')).toHaveText('Note restored.')
		await expect(page.getByTestId('board-undo')).toHaveCount(0)
		await page.keyboard.press('Control+y')
		await page.keyboard.press('Control+Shift+z')
		await expect(getNotes(page)).toHaveCount(2)
		await expect(page.getByTestId('board-redo')).toHaveCount(0)
	})

	test('undo countdown stays outside announcements and a stale-tab error clears', async ({ page }) => {
		await twoNotes(page)
		await deleteFirst(page)
		const toast = page.getByTestId('board-undo-toast')
		const announcement = page.getByTestId('board-note-announcement')
		await expect(announcement).toHaveText('Note deleted.')
		const countdown = toast.getByText(/^Undo available for /)
		const initialCountdown = await countdown.textContent()
		await expect(countdown).not.toHaveText(initialCountdown)
		await expect(announcement).toHaveText('Note deleted.')
		await expect(announcement.getByText(/^Undo available for /)).toHaveCount(0)

		const sameVisitor = await page.context().newPage()
		try {
			await openBoard(sameVisitor, page.url())
			await expect(sameVisitor.getByTestId('board-undo')).toBeEnabled()
			await page.getByTestId('board-undo').click()
			await expect(getNotes(sameVisitor)).toHaveCount(2)
			await sameVisitor.getByTestId('board-undo').click()
			const feedback = sameVisitor.getByTestId('board-note-announcement')
			await expect(feedback).toHaveText('Undo expired, was already used, or the note already exists')
			await expect(sameVisitor.getByTestId('board-undo')).toHaveCount(0)
			await expect(sameVisitor.getByTestId('board-undo-toast')).toHaveCount(0, { timeout: 8000 })
			await expect(getNotes(sameVisitor)).toHaveCount(2)
		} finally { await sameVisitor.close() }
	})

	test('persistent announcement reports a second deletion and restoration without countdown updates', async ({ page }) => {
		await twoNotes(page)
		const live = page.getByTestId('board-note-announcement')
		await expect(live).toHaveAttribute('role', 'status')
		await expect(live).toHaveAttribute('aria-atomic', 'true')
		await expect(live).toBeEmpty()
		const original = await live.elementHandle()
		await live.evaluate((node) => {
			node.announcementEvents = []
			new MutationObserver(() => node.announcementEvents.push(node.textContent)).observe(node, { childList: true, characterData: true, subtree: true })
		})
		await deleteFirst(page)
		await expect(live).toHaveText('Note deleted.')
		const second = getNotes(page).first()
		await second.hover({ force: true })
		await second.getByLabel('Delete note').click({ force: true })
		await expect(getNotes(page)).toHaveCount(0)
		await expect(live).toHaveText('Note deleted. 2 note deletions can be undone.')
		const beforeCountdown = await live.evaluate((node) => [...node.announcementEvents])
		const countdown = page.getByTestId('board-undo-toast').getByText(/^Undo available for /)
		const initialCountdown = await countdown.textContent()
		await expect(countdown).not.toHaveText(initialCountdown)
		await expect(live).toHaveText('Note deleted. 2 note deletions can be undone.')
		expect(await live.evaluate((node) => node.announcementEvents)).toEqual(beforeCountdown)
		await page.getByTestId('board-undo').click()
		await expect(getNotes(page)).toHaveCount(1)
		await expect(live).toHaveText('Note restored.')
		await live.evaluate((node) => {
			node.announcementFrames = [node.textContent]
			const sample = () => {
				if (node.announcementFrames.at(-1) !== node.textContent) node.announcementFrames.push(node.textContent)
				node.announcementFrameId = requestAnimationFrame(sample)
			}
			node.announcementFrameId = requestAnimationFrame(sample)
		})
		await page.getByTestId('board-undo').click()
		await expect(getNotes(page)).toHaveCount(2)
		await expect(page.getByTestId('board-undo-toast')).toHaveCount(0)
		await expect(live).toHaveText('Note restored.')
		await expect.poll(() => live.evaluate((node) => node.announcementFrames)).toEqual(['Note restored.', '', 'Note restored.'])
		await live.evaluate((node) => cancelAnimationFrame(node.announcementFrameId))
		expect(await original.evaluate((node) => node === document.querySelector('[data-testid="board-note-announcement"]'))).toBe(true)
	})

	test('an error keeps live deletion context and expiry does not announce another deletion', async ({ page }) => {
		let deleteRequests = 0
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((message) => {
				let request
				try { request = JSON.parse(String(message)) } catch {}
				if (request?.rpc === 'boards/notes/deleteNote' && ++deleteRequests === 2) {
					ws.send(JSON.stringify({ topic: '__rpc', event: request.id, data: { id: request.id, ok: false, code: 'INTERNAL_ERROR', error: 'Deletion refused by test server' } }))
					return
				}
				server.send(message)
			})
			server.onMessage((message) => ws.send(message))
		})
		await twoNotes(page)
		await deleteFirst(page)
		const note = getNotes(page).first()
		await note.hover({ force: true })
		await note.getByLabel('Delete note').click({ force: true })
		const toast = page.getByTestId('board-undo-toast')
		const live = page.getByTestId('board-note-announcement')
		await expect(toast).toContainText(/Deletion refused by test server[\s\S]*Note deleted\./)
		await expect(toast.getByText('Note deleted.', { exact: true })).toBeVisible()
		await expect(page.getByTestId('board-undo')).toBeEnabled()
		await expect(live).toHaveText('Deletion refused by test server')
		await expect(getNotes(page)).toHaveCount(1)
		await expect(toast.getByText('Deletion refused by test server', { exact: true })).toHaveCount(0, { timeout: 8000 })
		await expect(toast.getByText('Note deleted.', { exact: true })).toBeVisible()
		await expect(live).not.toHaveText('Note deleted.')
		await page.getByTestId('board-undo').click()
		await expect(getNotes(page)).toHaveCount(2)
		await expect(live).toHaveText('Note restored.')
	})

	test('Ctrl+Z inside a note keeps native text undo and does not restore a deletion', async ({ page }) => {
		await twoNotes(page)
		await deleteFirst(page)
		await getNotes(page).first().dblclick({ force: true })
		const editor = getNotes(page).first().locator('textarea')
		await editor.fill('Original text')
		await editor.press('End')
		await editor.pressSequentially(' extra')
		await expect(editor).toHaveValue('Original text extra')
		await editor.press('Control+z')
		await expect(editor).toHaveValue('Original text')
		await expect(getNotes(page)).toHaveCount(1)
		await expect(page.getByTestId('board-undo')).toBeEnabled()
	})

	test('server refuses another visitor, another board, replay and expiry', async ({ page, browser }) => {
		test.setTimeout(90_000)
		await page.goto('/')
		await waitForWS(page)
		const otherContext = await browser.newContext()
		const sockets = []
		try {
			const other = await otherContext.newPage()
			await other.goto(page.url())
			await waitForWS(other)
			const owner = await socketFor(page)
			const stranger = await socketFor(other)
			sockets.push(owner, stranger)
			const board = await callRpc(owner, 'boards/createBoard', ['Receipt permissions'])
			const secondBoard = await callRpc(owner, 'boards/createBoard', ['Other receipt board'])
			const note = await callRpc(owner, 'boards/notes/createNote', [board.board_id, { content: 'Keep this', x: 100, y: 100, color: '#fef08a' }])
			const receipt = await callRpc(owner, 'boards/notes/deleteNote', [board.board_id, note.note_id])
			await expect(callRpc(stranger, 'boards/notes/pendingNoteDeletions', [board.board_id])).resolves.toEqual([])
			await expect(callRpc(stranger, 'boards/notes/undoNoteDeletion', [board.board_id, receipt.token])).rejects.toThrow('CONFLICT')
			await expect(callRpc(owner, 'boards/notes/undoNoteDeletion', [secondBoard.board_id, receipt.token])).rejects.toThrow('CONFLICT')
			await expect(callRpc(owner, 'boards/notes/undoNoteDeletion', [board.board_id, receipt.token])).resolves.toMatchObject({ note_id: note.note_id, content: 'Keep this' })
			await expect(callRpc(owner, 'boards/notes/undoNoteDeletion', [board.board_id, receipt.token])).rejects.toThrow('CONFLICT')
			const expired = await callRpc(owner, 'boards/notes/deleteNote', [board.board_id, note.note_id])
			await page.waitForTimeout(expired.remainingMs + 100)
			await expect(callRpc(owner, 'boards/notes/undoNoteDeletion', [board.board_id, expired.token])).rejects.toThrow('CONFLICT')
			await expect(callRpc(owner, 'boards/notes/pendingNoteDeletions', [board.board_id])).resolves.toEqual([])
		} finally {
			for (const socket of sockets) socket.close()
			await otherContext.close()
		}
	})

	test('Ctrl+Z after a FAB shuffle leaves the shared arrangement in place', async ({ page }) => {
		await createFreshBoard(page, `Arrangement ${Date.now()}`)
		for (const [x, y] of [[150, 150], [450, 150], [750, 150]]) await createNote(page, x, y)
		await expect(getNotes(page)).toHaveCount(3)
		const before = JSON.stringify(await positions(page))
		await clickFabAction(page, 'Shuffle notes')
		await expect.poll(async () => JSON.stringify(await positions(page))).not.toBe(before)
		const shuffled = JSON.stringify(await positions(page))
		await page.locator('body').click({ position: { x: 5, y: 5 } })
		await page.keyboard.press('Control+z')
		await page.waitForTimeout(500)
		expect(JSON.stringify(await positions(page))).toBe(shuffled)
		await page.reload()
		await waitForWS(page)
		await waitForBoardReady(page)
		expect(JSON.stringify(await positions(page))).toBe(shuffled)
	})
})
