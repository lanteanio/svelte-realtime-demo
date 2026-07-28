import { test, expect } from '@playwright/test'
import {
	addCard,
	assertColumnCount,
	card,
	cardTitle,
	deleteCard,
	moveCard,
	openKanban,
	renameCard,
	waitForCard,
	waitInColumn
} from './kanban-helpers.js'

test.describe.configure({ mode: 'serial' })

test.describe('/demos/kanban', () => {
	test('renders all columns, forms, sync state, CRDT disclosure, and source link', async ({ page }) => {
		await openKanban(page)
		await expect(page.getByRole('heading', { name: 'Kanban: a shared CRDT document' })).toBeVisible()
		for (const column of ['todo', 'doing', 'done']) {
			await expect(page.getByTestId(`kb-col-${column}`)).toBeVisible()
			await expect(page.getByTestId(`kb-add-input-${column}`)).toHaveAttribute('placeholder', 'Add a card...')
			await expect(page.getByTestId(`kb-add-input-${column}`)).toBeEnabled()
			await expect(page.getByTestId(`kb-add-button-${column}`)).toBeDisabled()
			await assertColumnCount(page, column)
		}
		await expect(page.getByTestId('kb-syncing-badge')).toHaveCount(0)
		await expect(page.getByTestId('kb-degraded-badge')).toHaveCount(0)
		await expect(page.getByTestId('kb-readonly-badge')).toHaveCount(0)
		await expect(page.getByTestId('kb-error')).toHaveCount(0)
		await expect(page.getByText('local replica IS the offline queue', { exact: false }).first()).toBeVisible()
		await expect(page.getByRole('link', { name: 'src/live/demos/kanban.js' })).toHaveAttribute('href', /src\/live\/demos\/kanban\.js$/)
	})

	test('add-card inputs keep a useful target width across tablet and desktop-shell breakpoints', async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 900 })
		await openKanban(page)

		for (const width of [640, 768, 1024]) {
			await page.setViewportSize({ width, height: 900 })
			for (const column of ['todo', 'doing', 'done']) {
				const geometry = await page.getByTestId(`kb-add-input-${column}`).evaluate((input) => {
					const form = input.closest('form')
					const button = form?.querySelector('button')
					const inputBox = input.getBoundingClientRect()
					const formBox = form?.getBoundingClientRect()
					const buttonBox = button?.getBoundingClientRect()
					return {
						inputWidth: inputBox.width,
						buttonWidth: buttonBox?.width ?? 0,
						insideForm: Boolean(formBox && inputBox.left >= formBox.left && (buttonBox?.right ?? Infinity) <= formBox.right + 0.5)
					}
				})
				expect(geometry.inputWidth, `${column} input at ${width}px`).toBeGreaterThanOrEqual(96)
				expect(geometry.inputWidth, `${column} input vs Add button at ${width}px`).toBeGreaterThan(geometry.buttonWidth)
				expect(geometry.insideForm, `${column} form containment at ${width}px`).toBe(true)
			}
		}
	})

	test('all three add forms, inline rename, both move directions, reload, and delete work', async ({ page }) => {
		await openKanban(page)
		const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
		const ids = []
		try {
			ids.push(await addCard(page, 'todo', `e2e-todo-${stamp}`, true))
			ids.push(await addCard(page, 'doing', `e2e-doing-${stamp}`))
			ids.push(await addCard(page, 'done', `e2e-done-${stamp}`))
			const [todoId, doingId, doneId] = ids

			await expect(page.getByTestId(`kb-move-left-${todoId}`)).toBeDisabled()
			await expect(page.getByTestId(`kb-move-right-${doneId}`)).toBeDisabled()
			const renamed = `e2e-renamed-${stamp}`
			await renameCard(page, doingId, renamed)
			await expect(cardTitle(page, doingId)).toHaveValue(renamed)

			await moveCard(page, todoId, 'right', 'doing')
			await moveCard(page, todoId, 'right', 'done')
			await moveCard(page, doneId, 'left', 'doing')
			await moveCard(page, doneId, 'left', 'todo')
			for (const column of ['todo', 'doing', 'done']) await assertColumnCount(page, column)

			await page.reload()
			await expect(page.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })
			await waitInColumn(page, todoId, 'done')
			await waitInColumn(page, doneId, 'todo')
			await expect(cardTitle(page, doingId)).toHaveValue(renamed)
		} finally {
			for (const id of ids) await deleteCard(page, id)
		}
	})

	test('two identities concurrently move and rename different cards without index-shift loss', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const ids = []
		try {
			await Promise.all([openKanban(a), openKanban(b)])
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const [idA, idB] = await Promise.all([
				addCard(a, 'todo', `e2e-concurrent-a-${stamp}`),
				addCard(b, 'todo', `e2e-concurrent-b-${stamp}`)
			])
			ids.push(idA, idB)
			await Promise.all([waitInColumn(a, idB, 'todo'), waitInColumn(b, idA, 'todo')])

			await Promise.all([
				moveCard(a, idA, 'right', 'doing'),
				moveCard(b, idB, 'right', 'doing')
			])
			await Promise.all([
				waitInColumn(a, idB, 'doing'),
				waitInColumn(b, idA, 'doing')
			])
			await Promise.all([
				renameCard(a, idA, `e2e-a-renamed-${stamp}`),
				renameCard(b, idB, `e2e-b-renamed-${stamp}`)
			])
			await expect(cardTitle(a, idB)).toHaveValue(`e2e-b-renamed-${stamp}`, { timeout: 10_000 })
			await expect(cardTitle(b, idA)).toHaveValue(`e2e-a-renamed-${stamp}`, { timeout: 10_000 })
		} finally {
			for (const id of ids) await deleteCard(b, id)
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('offline local edits and online peer edits reconcile after reconnect', async ({ browser }) => {
		test.setTimeout(45_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const ids = []
		try {
			await Promise.all([openKanban(a), openKanban(b)])
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const ownId = await addCard(a, 'todo', `e2e-offline-own-${stamp}`)
			const peerId = await addCard(b, 'todo', `e2e-offline-peer-${stamp}`)
			ids.push(ownId, peerId)
			await Promise.all([waitForCard(a, `e2e-offline-peer-${stamp}`), waitForCard(b, `e2e-offline-own-${stamp}`)])

			await ctxA.setOffline(true)
			await renameCard(a, ownId, `e2e-offline-own-edited-${stamp}`)
			await moveCard(a, ownId, 'right', 'doing')
			await renameCard(b, peerId, `e2e-offline-peer-edited-${stamp}`)
			await moveCard(b, peerId, 'right', 'doing')
			await expect(cardTitle(a, peerId)).toHaveValue(`e2e-offline-peer-${stamp}`)
			await expect(cardTitle(b, ownId)).toHaveValue(`e2e-offline-own-${stamp}`)

			await ctxA.setOffline(false)
			await expect(a.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 20_000 })
			await expect(cardTitle(a, peerId)).toHaveValue(`e2e-offline-peer-edited-${stamp}`, { timeout: 20_000 })
			await expect(cardTitle(b, ownId)).toHaveValue(`e2e-offline-own-edited-${stamp}`, { timeout: 20_000 })
			await Promise.all([
				waitInColumn(a, peerId, 'doing'),
				waitInColumn(b, ownId, 'doing')
			])
		} finally {
			await ctxA.setOffline(false).catch(() => {})
			for (const id of ids) await deleteCard(b, id)
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
