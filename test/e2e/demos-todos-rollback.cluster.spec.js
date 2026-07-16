import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/todos-rollback: the todos hash is a single
// cluster-shared Redis key, so a todo added (or removed) on replica A must
// reach a subscriber on replica B via the bus fan-out. Cluster tier only.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

let seq = 0
const uniq = (label) => `${label}-${Date.now()}-${seq++}`

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/todos-rollback`)
	await waitForWS(page)
}

test.describe('cluster: /demos/todos-rollback cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('a todo added on replica A appears (and its removal propagates) on replica B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			const text = uniq('xrep')
			await a.getByTestId('todo-input').fill(text)
			await a.getByTestId('add-button').click()

			const aRow = a.getByTestId('todos').locator('li', { hasText: text })
			const bRow = b.getByTestId('todos').locator('li', { hasText: text })
			await expect(aRow).toHaveCount(1, { timeout: 15_000 })
			// The cross-replica 'created' fan-out delivers it to B.
			await expect(bRow).toHaveCount(1, { timeout: 15_000 })

			// Remove on A; the 'deleted' event must clear it on B too.
			await aRow.locator('[data-testid^="todo-remove-"]').click()
			await expect(aRow).toHaveCount(0, { timeout: 15_000 })
			await expect(bRow).toHaveCount(0, { timeout: 15_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
