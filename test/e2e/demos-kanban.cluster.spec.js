import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	addCard,
	cardTitle,
	deleteCard,
	moveCard,
	openKanban,
	renameCard,
	waitInColumn
} from './kanban-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'kanban cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/kanban', () => {
	test('different cards edited concurrently on explicit replicas converge without transient duplication', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const ids = []
		try {
			await Promise.all([
				openKanban(a, `${INSTANCE_A}/demos/kanban`),
				openKanban(b, `${INSTANCE_B}/demos/kanban`)
			])
			const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
			const [idA, idB] = await Promise.all([
				addCard(a, 'todo', `e2e-cluster-a-${stamp}`),
				addCard(b, 'todo', `e2e-cluster-b-${stamp}`)
			])
			ids.push(idA, idB)
			await Promise.all([waitInColumn(a, idB, 'todo'), waitInColumn(b, idA, 'todo')])

			await Promise.all([
				moveCard(a, idA, 'right', 'doing'),
				moveCard(b, idB, 'right', 'doing'),
				renameCard(a, idA, `e2e-cluster-a-renamed-${stamp}`),
				renameCard(b, idB, `e2e-cluster-b-renamed-${stamp}`)
			])
			for (const page of [a, b]) {
				await waitInColumn(page, idA, 'doing')
				await waitInColumn(page, idB, 'doing')
				await expect(cardTitle(page, idA)).toHaveValue(`e2e-cluster-a-renamed-${stamp}`, { timeout: 10_000 })
				await expect(cardTitle(page, idB)).toHaveValue(`e2e-cluster-b-renamed-${stamp}`, { timeout: 10_000 })
			}
		} finally {
			for (const id of ids) await deleteCard(b, id)
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
