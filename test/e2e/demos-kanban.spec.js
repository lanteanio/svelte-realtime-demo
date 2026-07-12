import { test, expect } from '@playwright/test'

// The kanban board is ONE shared document for every visitor, so state
// accumulates across test runs. Every card this spec creates carries a
// Date.now() suffix and is deleted at the end of its test, keeping the
// shared board clean for repeated runs.
//
// Card titles live in <input value=...> elements, not text nodes, so
// membership checks go through data-testid card ids (stable across
// moves and reloads) rather than hasText locators.

test.describe('/demos/kanban', () => {
	test('page loads and the document syncs', async ({ page }) => {
		await page.goto('/demos/kanban')
		await expect(page.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })
		for (const col of ['todo', 'doing', 'done']) {
			await expect(page.getByTestId(`kb-col-${col}`)).toBeVisible()
		}
	})

	test('add, move across columns, survive a reload, delete', async ({ page }) => {
		await page.goto('/demos/kanban')
		await expect(page.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })

		// Add a uniquely-named card to the todo column.
		const title = `e2e-card-${Date.now()}`
		await page.getByTestId('kb-add-input-todo').fill(title)
		await page.getByTestId('kb-add-button-todo').click()

		// push() appends, so the new card is the last one in the column.
		// Writes apply to the local replica synchronously - no network wait.
		const added = page.getByTestId('kb-cards-todo').locator('[data-testid^="kb-card-"]').last()
		await expect(added.locator('[data-testid^="kb-title-"]')).toHaveValue(title)

		// Pin the card's id so it can be tracked through moves and reloads.
		const cardTestId = await added.getAttribute('data-testid')
		const cardId = cardTestId.slice('kb-card-'.length)

		// Move it right into doing: one transact = one atomic wire update.
		await page.getByTestId(`kb-move-right-${cardId}`).click()
		await expect(page.getByTestId('kb-cards-doing').getByTestId(`kb-card-${cardId}`)).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('kb-cards-todo').getByTestId(`kb-card-${cardId}`)).toHaveCount(0)

		// Reload: the server replica is in-memory for the process lifetime,
		// so a fresh sync must bring the card back in the doing column.
		await page.reload()
		await expect(page.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })
		const reloaded = page.getByTestId('kb-cards-doing').getByTestId(`kb-card-${cardId}`)
		await expect(reloaded).toBeVisible({ timeout: 10_000 })
		await expect(reloaded.locator('[data-testid^="kb-title-"]')).toHaveValue(title)

		// Cleanup: delete the card (order entry + cards record in one
		// transaction) so repeated runs never pile up state.
		await page.getByTestId(`kb-delete-${cardId}`).click()
		await expect(page.getByTestId(`kb-card-${cardId}`)).toHaveCount(0, { timeout: 5_000 })
	})

	test('concurrent adds from two contexts converge on both boards', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/kanban')
			await b.goto('/demos/kanban')
			await expect(a.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })
			await expect(b.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })

			const title = `e2e-sync-${Date.now()}`
			await a.getByTestId('kb-add-input-todo').fill(title)
			await a.getByTestId('kb-add-button-todo').click()

			const added = a.getByTestId('kb-cards-todo').locator('[data-testid^="kb-card-"]').last()
			await expect(added.locator('[data-testid^="kb-title-"]')).toHaveValue(title)
			const cardTestId = await added.getAttribute('data-testid')
			const cardId = cardTestId.slice('kb-card-'.length)

			// The merge lands on B without any RPC or refetch.
			const onB = b.getByTestId('kb-cards-todo').getByTestId(`kb-card-${cardId}`)
			await expect(onB).toBeVisible({ timeout: 10_000 })
			await expect(onB.locator('[data-testid^="kb-title-"]')).toHaveValue(title)

			// Cleanup from B: a delete merged from the other side must also
			// converge back to A.
			await b.getByTestId(`kb-delete-${cardId}`).click()
			await expect(a.getByTestId(`kb-card-${cardId}`)).toHaveCount(0, { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
