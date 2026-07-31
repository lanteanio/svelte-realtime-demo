import { test, expect } from '@playwright/test'
import { confirmAndClick, expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/todos-rollback - optimistic mutate
// with concurrent-failure rollback. Drives add / toggle / remove / clear /
// spam, the Force-fail toggle, and asserts REAL outcomes: an optimistic add is
// confirmed by the server, a forced add ROLLS BACK and surfaces a FORCED error
// toast (no phantom trace), five concurrent forced adds all roll back cleanly,
// and edits fan out to other tabs.
//
// The todos hash is a single cluster-shared Redis key, so tests use unique
// text and assert on that text (robust to other todos). Count/empty assertions
// clear first. Cross-replica assertions live in demos-todos-rollback.cluster.spec.js.

let seq = 0
const uniq = (label) => `${label}-${Date.now()}-${seq++}`

async function open(page) {
	await page.goto('/demos/todos-rollback')
	await waitForWS(page)
}

async function clearAll(page) {
	// Wait for the stream to actually hydrate before deciding whether to clear -
	// otherwise a pre-hydration read could miss existing global todos and skip
	// the clear, leaving stale shared state.
	await expect(page.getByTestId('todos')).toHaveAttribute('data-hydrated', 'true', { timeout: 10_000 })
	const clear = page.getByTestId('clear-button')
	if (await clear.isVisible().catch(() => false)) {
		// Clear-all is confirm-gated (shared demo state); a bare click's
		// dialog is auto-dismissed by Playwright and the RPC never fires.
		await confirmAndClick(clear)
		await expect(page.getByTestId('todos')).toContainText(/No todos yet/i, { timeout: 10_000 })
	}
}

test.describe('/demos/todos-rollback', () => {
	test('an add applies optimistically and the server confirms it (Force-fail OFF)', async ({ page }) => {
		await open(page)
		await expect(page.getByTestId('force-fail-toggle')).not.toBeChecked()

		const text = uniq('add')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()

		const li = page.getByTestId('todos').locator('li', { hasText: text })
		await expect(li).toHaveCount(1, { timeout: 10_000 })
		await expect(page.getByTestId('todo-input')).toHaveValue('')
		// It survives past the round-trip (a rejected add would have rolled back).
		await page.waitForTimeout(500)
		await expect(li).toHaveCount(1)
	})

	test('an add renders optimistically, before the server can confirm it', async ({ page }) => {
		test.setTimeout(30_000)
		// Delay every server->client WS frame. The optimistic placeholder is
		// applied client-side the instant Add is clicked, but the server's
		// confirming 'created' event now cannot arrive for SERVER_DELAY ms - so
		// if the row is visible well inside that window it MUST be the optimistic
		// render, not the server round-trip. A non-optimistic implementation
		// would show nothing until the delayed confirm landed.
		const SERVER_DELAY = 1500
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => { setTimeout(() => ws.send(m), SERVER_DELAY) })
		})
		await open(page)

		const text = uniq('optimistic')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()

		const row = page.getByTestId('todos').locator('li', { hasText: text })
		// Visible far sooner than the server could possibly have replied.
		await expect(row).toHaveCount(1, { timeout: SERVER_DELAY - 700 })
		// And once the delayed confirm lands, the row persists (crud merge by id).
		await page.waitForTimeout(SERVER_DELAY)
		await expect(row).toHaveCount(1)
	})

	test('Add is disabled until the draft is non-empty', async ({ page }) => {
		await open(page)
		await expect(page.getByTestId('add-button')).toBeDisabled()
		await page.getByTestId('todo-input').fill('x')
		await expect(page.getByTestId('add-button')).toBeEnabled()
	})

	test('toggling marks a todo done and back', async ({ page }) => {
		await open(page)
		const text = uniq('toggle')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()
		const li = page.getByTestId('todos').locator('li', { hasText: text })
		await expect(li).toHaveCount(1, { timeout: 10_000 })

		const box = li.locator('[data-testid^="todo-toggle-"]')
		await box.click()
		await expect(box).toBeChecked()
		await expect(li.locator('span.line-through')).toHaveCount(1)

		// The done state must PERSIST server-side, not just flip optimistically:
		// a reload rehydrates from Redis and the box is still checked.
		await page.reload()
		await waitForWS(page)
		const boxAfter = page.getByTestId('todos').locator('li', { hasText: text }).locator('[data-testid^="todo-toggle-"]')
		await expect(boxAfter).toBeChecked({ timeout: 10_000 })

		await boxAfter.click()
		await expect(boxAfter).not.toBeChecked()
		await expect(page.getByTestId('todos').locator('li', { hasText: text }).locator('span.line-through')).toHaveCount(0)
	})

	test('removing deletes a todo', async ({ page }) => {
		await open(page)
		const text = uniq('remove')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()
		const li = page.getByTestId('todos').locator('li', { hasText: text })
		await expect(li).toHaveCount(1, { timeout: 10_000 })

		await li.locator('[data-testid^="todo-remove-"]').click()
		await expect(li).toHaveCount(0, { timeout: 10_000 })
	})

	test('Clear all empties the list', async ({ page }) => {
		await open(page)
		await clearAll(page)
		for (const t of [uniq('clear-a'), uniq('clear-b')]) {
			await page.getByTestId('todo-input').fill(t)
			await page.getByTestId('add-button').click()
			await expect(page.getByTestId('todos').locator('li', { hasText: t })).toHaveCount(1, { timeout: 10_000 })
		}
		await confirmAndClick(page.getByTestId('clear-button'))
		await expect(page.getByTestId('todos')).toContainText(/No todos yet/i, { timeout: 10_000 })
	})

	test('a forced add rolls back and surfaces a FORCED error toast', async ({ page }) => {
		await open(page)
		await page.getByTestId('force-fail-toggle').check()

		const text = uniq('forced')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()

		// The FORCED reject must surface as an error toast - this proves the RPC
		// fired and was rejected (guards against a vacuous "text never appeared").
		await expect(page.locator('.alert-error', { hasText: 'FORCED' })).toBeVisible({ timeout: 10_000 })
		// ...and the optimistic placeholder must be gone (rolled back).
		await expect(page.getByTestId('todos').locator('li', { hasText: text })).toHaveCount(0, { timeout: 10_000 })
	})

	test('five concurrent forced adds all roll back with no phantom traces', async ({ page }) => {
		await open(page)
		await clearAll(page)
		await page.getByTestId('force-fail-toggle').check()

		const base = uniq('spam')
		await page.getByTestId('todo-input').fill(base)
		await page.getByTestId('spam-button').click()

		// At least one FORCED error surfaces (the RPCs fired and rejected)...
		await expect(page.locator('.alert-error', { hasText: 'FORCED' }).first()).toBeVisible({ timeout: 10_000 })
		// ...and none of the five placeholders survive - the list is clean.
		await expect(page.getByTestId('todos').locator('li', { hasText: base })).toHaveCount(0, { timeout: 10_000 })
		await expect(page.getByTestId('todos')).toContainText(/No todos yet/i, { timeout: 10_000 })
	})

	test('Spam x5 with Force-fail OFF adds five todos', async ({ page }) => {
		await open(page)
		await clearAll(page)
		const base = uniq('ok-spam')
		await page.getByTestId('todo-input').fill(base)
		await page.getByTestId('spam-button').click()
		// baseText-1..5 all land and are confirmed.
		await expect(page.getByTestId('todos').locator('li', { hasText: base })).toHaveCount(5, { timeout: 10_000 })
	})

	test('todos survive a reload (loader rehydrates from Redis)', async ({ page }) => {
		await open(page)
		const text = uniq('persist')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()
		await expect(page.getByTestId('todos').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })

		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('todos').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })
	})

	test('an add in one tab appears in another', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const text = uniq('sync')
			await a.getByTestId('todo-input').fill(text)
			await a.getByTestId('add-button').click()
			await expect(a.getByTestId('todos').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })
			await expect(b.getByTestId('todos').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			const text = uniq('touch')
			await page.getByTestId('todo-input').fill(text)
			await page.getByTestId('add-button').click()
			const li = page.getByTestId('todos').locator('li', { hasText: text })
			await expect(li).toHaveCount(1, { timeout: 10_000 })

			await expectTouchTarget(page.getByTestId('todo-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('add-button'))
			// Checkbox floor is the 24px WCAG AA minimum, not the 44px button floor.
			await expectTouchTarget(li.locator('[data-testid^="todo-toggle-"]'), { minWidth: 24, minHeight: 24 })
			await expectTouchTarget(li.locator('[data-testid^="todo-remove-"]'))

			await li.locator('[data-testid^="todo-remove-"]').click()
			await expect(li).toHaveCount(0, { timeout: 10_000 })
		} finally {
			await context.close()
		}
	})
})
