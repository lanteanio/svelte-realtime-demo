import { test, expect } from '@playwright/test'

test.describe('/demos/todos-rollback', () => {
	test('happy path: add, toggle, remove with force-fail OFF', async ({ page }) => {
		await page.goto('/demos/todos-rollback')

		// Force-fail starts OFF.
		await expect(page.getByTestId('force-fail-toggle')).not.toBeChecked()

		const text = `t-${Date.now()}`
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()
		await expect(page.getByTestId('todos')).toContainText(text, { timeout: 5_000 })

		// Toggle then remove this todo via its data-testid suffix.
		const li = page.getByTestId('todos').locator('li', { hasText: text })
		await li.locator('[data-testid^="todo-toggle-"]').click()
		await expect(li.locator('[data-testid^="todo-toggle-"]')).toBeChecked()

		await li.locator('[data-testid^="todo-remove-"]').click()
		await expect(page.getByTestId('todos')).not.toContainText(text)
	})

	test('forced rollback: single add with force-fail ON disappears', async ({ page }) => {
		await page.goto('/demos/todos-rollback')
		// Clean any leftover state from prior runs.
		const clear = page.getByTestId('clear-button')
		if (await clear.isVisible().catch(() => false)) await clear.click()

		await page.getByTestId('force-fail-toggle').check()
		const text = `forced-${Date.now()}`
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()

		// Optimistic placeholder appears, then rolls back. After ~500ms it
		// should be gone - the FORCED reject from the server triggers
		// rollback, restoring the displayed list to server state.
		await expect(page.getByTestId('todos')).not.toContainText(text, { timeout: 3_000 })
	})

	test('concurrent rollback: spam x5 with force-fail ON, all roll back independently', async ({ page }) => {
		await page.goto('/demos/todos-rollback')
		const clear = page.getByTestId('clear-button')
		if (await clear.isVisible().catch(() => false)) await clear.click()

		await page.getByTestId('force-fail-toggle').check()
		const baseText = `spam-${Date.now()}`
		await page.getByTestId('todo-input').fill(baseText)
		await page.getByTestId('spam-button').click()

		// Five placeholders appear briefly, then all five roll back.
		// End state: zero todos with the spam prefix.
		await page.waitForTimeout(1500)
		const remaining = await page.getByTestId('todos').locator('li', { hasText: baseText }).count()
		expect(remaining).toBe(0)
	})

	test('cross-context sync: an add in A appears in B', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/todos-rollback')
			await b.goto('/demos/todos-rollback')

			const text = `sync-${Date.now()}`
			await a.getByTestId('todo-input').fill(text)
			await a.getByTestId('add-button').click()

			await expect(a.getByTestId('todos')).toContainText(text, { timeout: 5_000 })
			await expect(b.getByTestId('todos')).toContainText(text, { timeout: 5_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
