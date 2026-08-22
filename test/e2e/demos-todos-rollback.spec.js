import { test, expect } from '@playwright/test'
import { confirmAndClick, expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'
import { FORCED_FAIL_DELAY_MS, TOAST_MS } from '../../src/live/demos/todos-rollback.shared.js'

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

	// The act every step of this page begins with used to happen in the
	// smallest target on screen: the form row could not wrap, so at 320 the
	// input collapsed to about 70px and its placeholder truncated mid-word.
	// Asserted as a fraction of the form, not as a pixel floor - a floor
	// passes on a wider phone while still failing the narrowest one.
	test('the add input keeps a usable width where the form has to wrap', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 320, height: 568 } })
		const page = await context.newPage()
		try {
			await open(page)
			const geometry = await page.getByTestId('todo-input').evaluate((input) => {
				const form = input.closest('form')
				return {
					input: input.getBoundingClientRect().width,
					form: form.getBoundingClientRect().width,
					inputTop: Math.round(input.getBoundingClientRect().top),
					buttonTop: Math.round(form.querySelector('[data-testid="add-button"]').getBoundingClientRect().top)
				}
			})
			expect(geometry.input / geometry.form, 'the input takes the row it is on').toBeGreaterThan(0.9)
			// It takes that row because the buttons moved below it, which is the
			// mechanism - an input that merely grew would push them off-screen.
			expect(geometry.buttonTop, 'the buttons wrap to their own line').toBeGreaterThan(geometry.inputTop)

			// And the placeholder is readable rather than clipped mid-word.
			const clipped = await page.getByTestId('todo-input')
				.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
			expect(clipped, 'the placeholder must fit the field').toBe(false)
		} finally {
			await context.close()
		}
	})

	// Every control names what it acts on. The checkbox and the remove glyph
	// had no accessible name at all, so the row announced as unlabelled
	// controls and the todo's text was the only way to tell them apart.
	test('each row control carries an accessible name that names its todo', async ({ page }) => {
		await open(page)
		await clearAll(page)
		const text = uniq('named')
		await page.getByTestId('todo-input').fill(text)
		await page.getByTestId('add-button').click()
		const row = page.getByTestId('todos').locator('li', { hasText: text })
		await expect(row).toHaveCount(1, { timeout: 10_000 })

		await expect(row.getByRole('checkbox', { name: `Done: ${text}` })).toHaveCount(1)
		await expect(row.getByRole('button', { name: `Remove: ${text}` })).toHaveCount(1)
		await expect(page.getByLabel('New todo')).toHaveCount(1)
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

		// And it must leave ON TIME. A toast that appears is half the contract;
		// one that never expires occludes the list it was reporting on, which is
		// the whole reason the stack is bounded. This is the single-toast path -
		// one error, never repeated - and it is the one that strands, because the
		// coalescing path removes correctly by accident.
		//
		// The deadline is the DECLARED lifetime, not a round number. Ten seconds
		// against a declared 3.5 accepts a toast outliving its contract by a
		// factor of three, which is a regression this test would have reported as
		// a pass. The margin covers the round trip that created the toast and the
		// poll that observes it leaving, both of which run before the clock here
		// starts, so the budget is already generous against the real deadline.
		await expect(
			page.getByTestId('todo-toast'),
			`a single error toast must expire within its declared ${TOAST_MS}ms, not merely eventually`
		).toHaveCount(0, { timeout: TOAST_MS + 1000 })
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

	// Five identical failures used to stack five alerts, which on a phone rung
	// cover the lower half of the viewport - including the Todos card - during
	// exactly the seconds the placeholders vanish. The feedback destroyed the
	// view it was reporting on, and five copies of one sentence say nothing the
	// count does not. Asserted at a phone width, since that is where the
	// occlusion is: at desktop width five alerts fit and the old behaviour
	// would pass.
	test('a burst of identical failures reports once with a count, inside the viewport', async ({ browser }) => {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
		const page = await context.newPage()
		try {
			await open(page)
			await clearAll(page)
			await page.getByTestId('force-fail-toggle').check()
			await page.getByTestId('todo-input').fill(uniq('burst'))
			await page.getByTestId('spam-button').click()

			const toasts = page.getByTestId('todo-toast')
			await expect(toasts).toHaveCount(1, { timeout: 10_000 })
			await expect(page.getByTestId('todo-toast-text')).toContainText('5x')
			await expect(page.getByTestId('todo-toast-text')).toContainText('FORCED')

			// And it fits: max-w-md is 448px, wider than this viewport, so an
			// unclamped alert would run off the side of the screen it reports to.
			const overflow = await toasts.first().evaluate((el) => {
				const box = el.getBoundingClientRect()
				return { right: box.right, left: box.left, viewport: window.innerWidth }
			})
			expect(overflow.right).toBeLessThanOrEqual(overflow.viewport)
			expect(overflow.left).toBeGreaterThanOrEqual(0)
		} finally {
			await context.close()
		}
	})

	// The page's own script is "watch the placeholder appear, then disappear",
	// and an immediate throw made that a single fast round trip - tens of
	// milliseconds on a local connection, so the visitor saw a toast and an
	// unchanged list and never observed the rollback at all. Asserted by
	// catching the placeholder WHILE it is up, which is only possible if the
	// window is perceptible; the existing tests only assert the end state and
	// pass whether or not anything was ever visible.
	test('a rolled-back row is on screen long enough to be seen', async ({ page }) => {
		await open(page)
		await clearAll(page)
		await page.getByTestId('force-fail-toggle').check()

		const text = uniq('perceptible')
		await page.getByTestId('todo-input').fill(text)
		const row = page.getByTestId('todos').locator('li', { hasText: text })
		await page.getByTestId('add-button').click()

		// Up first...
		await expect(row).toHaveCount(1, { timeout: 5_000 })
		// ...and then rolled back, so this is the arc and not a row that stuck.
		await expect(row).toHaveCount(0, { timeout: 10_000 })
	})

	// The page explains its own mechanism, and that explanation is part of the
	// demo rather than decoration: a visitor reads it to learn what the
	// primitive does. It claimed the handler throws IMMEDIATELY, which stopped
	// being true the moment a delay was added to make the rollback visible - so
	// the page was teaching one thing while doing another, and the delay looked
	// like latency rather than a deliberate choice.
	test('the mechanism note states the deliberate delay instead of claiming an immediate throw', async ({ page }) => {
		await open(page)
		// The layout contributes an <aside> of its own, so target the page's
		// note rather than whichever one happens to come first.
		const aside = page.getByTestId('tr-mechanism-note')
		// Read from the same constant the handler waits on, not from a literal.
		// Three independent copies of this number agreed until one of them moved,
		// and nothing failed when they stopped agreeing - which is the whole
		// defect this note exists to prevent, reproduced in the regression that
		// was supposed to catch it.
		await expect(aside).toContainText(`${FORCED_FAIL_DELAY_MS}ms`)
		await expect(aside).toContainText('FORCED')
		await expect(
			aside,
			'the note must not describe a throw the handler no longer performs'
		).not.toContainText('immediately')
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
			// This checkbox is BARE in the sense the policy means: nothing but a
			// label wraps it, and the label exists solely to be the target. The
			// floor therefore lands on the label, not on the drawn box - so both
			// halves have to be pinned, because either alone passes for the wrong
			// reason. A 44px drawn box satisfies a size check while redesigning the
			// control, and a small drawn box satisfies the design while leaving a
			// finger nothing to hit.
			const toggle = li.locator('[data-testid^="todo-toggle-"]')
			// Into view BEFORE measuring. A row below the fold still reports a box,
			// and hit-testing that point returns nothing at all - which reads as a
			// target that does not reach when it means a measurement taken
			// off-screen.
			await toggle.scrollIntoViewIfNeeded()
			const drawn = await toggle.boundingBox()
			expect(drawn, 'the checkbox must be visible to measure').not.toBeNull()
			expect(drawn.width, 'the DRAWN control keeps its designed size').toBeLessThan(44)
			expect(drawn.height, 'the DRAWN control keeps its designed size').toBeLessThan(44)

			// The target is asserted where a finger would land: 20px right of the
			// drawn centre is outside the box a reader sees and inside the 44px
			// target, so it can only belong to the control if the target really
			// extends there.
			//
			// The oracle is the browser's own hit test rather than the checkbox's
			// resulting state, and that is deliberate: earlier tests in this file
			// leave the demo in force-fail mode, where a toggle that DOES land is
			// rolled back by design. A rollback and a missed tap are indistinguish-
			// able afterwards, so asserting the checkbox flipped would fail on a
			// working target and pass only by accident of test order.
			const testid = await toggle.getAttribute('data-testid')
			const belongsToControl = await page.evaluate(([x, y, id]) => {
				const hit = document.elementFromPoint(x, y)
				const input = document.querySelector(`[data-testid="${id}"]`)
				if (!hit || !input) return false
				// A label activates the control it wraps; an ancestor row does not,
				// and would contain the input just the same.
				return hit === input || (hit.tagName === 'LABEL' && hit.contains(input))
			}, [drawn.x + drawn.width / 2 + 20, drawn.y + drawn.height / 2, testid])
			expect(belongsToControl, 'a point 20px from the drawn control must still belong to that control').toBe(true)
			await expectTouchTarget(li.locator('[data-testid^="todo-remove-"]'))

			await li.locator('[data-testid^="todo-remove-"]').click()
			await expect(li).toHaveCount(0, { timeout: 10_000 })
		} finally {
			await context.close()
		}
	})
})
