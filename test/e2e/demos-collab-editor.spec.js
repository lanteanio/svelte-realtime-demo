import { test, expect } from '@playwright/test'
import { confirmAndClick, waitForWS, openTouchPage, expectTouchTarget } from './helpers.js'

test.describe.configure({ mode: 'serial' })

async function open(page) {
	await page.goto('/demos/collab-editor')
	await waitForWS(page)
	await expect(page.getByTestId('collab-doc-synced')).toHaveText('synced', { timeout: 15_000 })
	await expect(page.getByTestId('collab-offset-textarea')).toBeEditable()
	await expect(page.getByTestId('collab-crdt-textarea')).toBeEditable()
}

async function clear(page) {
	await confirmAndClick(page.getByTestId('collab-clear'))
	for (const id of ['collab-offset-textarea', 'collab-crdt-textarea']) {
		await expect(page.getByTestId(id)).toHaveValue('', { timeout: 10_000 })
	}
	await expect(page.getByTestId('collab-doc-length')).toHaveText('0 chars')
}

async function expectDocument(page, value) {
	await expect(page.getByTestId('collab-offset-textarea')).toHaveValue(value, { timeout: 10_000 })
	await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(value, { timeout: 10_000 })
	await expect(page.getByTestId('collab-doc-length')).toHaveText(`${value.length} chars`)
}

// Focus + setSelectionRange fires a real document selectionchange in
// Chromium, which is the event the page listens to - no synthetic
// events, so a listener regression cannot pass silently.
async function selectRange(locator, start, end) {
	await locator.evaluate((element, range) => {
		element.focus()
		element.setSelectionRange(range.start, range.end)
	}, { start, end })
}

test.describe('/demos/collab-editor', () => {
	test('renders both exact modes, the run script, sync/readout state, empty selection guidance, and control constraints', async ({ page }) => {
		await open(page)
		await clear(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Collab editor: selections that survive edits')
		await expect(page.getByTestId('collab-steps').locator('li')).toHaveCount(3)
		await expect(page.getByTestId('collab-steps')).toContainText('type in front of that word')
		await expect(page.getByTestId('collab-offset-panel')).toContainText("selections: 'offset'")
		await expect(page.getByTestId('collab-crdt-panel')).toContainText("selections: 'crdt'")
		for (const id of ['collab-offset-selections-empty', 'collab-crdt-selections-empty']) {
			await expect(page.getByTestId(id)).toBeVisible()
			await expect(page.getByTestId(id)).toContainText('Select text in the box above')
		}
		for (const id of ['collab-offset-textarea', 'collab-crdt-textarea']) {
			await expect(page.getByTestId(id)).toHaveAttribute('maxlength', '4000')
			await expect(page.getByTestId(id)).toHaveAttribute('placeholder', /other panel.*other tab/)
		}
		await expect(page.getByTestId('collab-clear')).toHaveText('Clear document')
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('both panels can edit the same document and keyboard replacement applies a minimal splice', async ({ page }) => {
		await open(page)
		await clear(page)
		const initial = 'alpha TARGET omega'
		await page.getByTestId('collab-offset-textarea').fill(initial)
		await expectDocument(page, initial)

		const prefixed = `PREFIX ${initial}`
		await page.getByTestId('collab-crdt-textarea').fill(prefixed)
		await expectDocument(page, prefixed)

		const crdt = page.getByTestId('collab-crdt-textarea')
		await selectRange(crdt, 7, 13)
		await crdt.press('Backspace')
		const deleted = 'PREFIX TARGET omega'
		await expectDocument(page, deleted)
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('Clear removes a populated persisted document from both panels and remains a safe empty no-op', async ({ page }) => {
		await open(page)
		const value = `clear-${Date.now()}`
		await page.getByTestId('collab-crdt-textarea').fill(value)
		await expectDocument(page, value)
		await clear(page)
		await clear(page)
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('offset and CRDT selections publish, then a collapsed caret clears each local range without errors', async ({ page }) => {
		await open(page)
		await clear(page)
		const value = 'select this text'
		await page.getByTestId('collab-offset-textarea').fill(value)
		await expectDocument(page, value)
		for (const id of ['collab-offset-textarea', 'collab-crdt-textarea']) {
			const textarea = page.getByTestId(id)
			await selectRange(textarea, 0, 6)
			const prefix = id.replace('-textarea', '')
			await expect(page.locator(`[data-testid="${prefix}-selection-row"][data-local="true"]`)).toContainText('[0, 6)')
			await expect(page.locator(`[data-testid="${prefix}-selection-row"][data-local="true"]`)).toContainText('"select"')
			await expect(page.locator(`[data-testid="${prefix}-selection-row"][data-local="true"]`).getByText('you', { exact: true })).toBeVisible()
			await selectRange(textarea, 6, 6)
		}
		await expect(page.getByTestId('collab-offset-selection-row')).toHaveCount(0)
		await expect(page.getByTestId('collab-crdt-selection-row')).toHaveCount(0)
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('an edit in front of a published offset range flags the drift in the row; the CRDT panel never carries the cue', async ({ page }) => {
		await open(page)
		await clear(page)
		const value = 'alpha TARGET omega'
		await page.getByTestId('collab-offset-textarea').fill(value)
		await expectDocument(page, value)
		await selectRange(page.getByTestId('collab-offset-textarea'), 6, 12)
		const local = page.locator('[data-testid="collab-offset-selection-row"][data-local="true"]')
		await expect(local).toContainText('"TARGET"')
		await expect(page.getByTestId('collab-offset-selection-drift')).toHaveCount(0)
		// Edit through the OTHER panel: same document, so the frozen offset
		// numbers keep pointing at positions the text has moved out of.
		await page.getByTestId('collab-crdt-textarea').fill(`XX ${value}`)
		await expectDocument(page, `XX ${value}`)
		await expect(local).toContainText('selected "TARGET"')
		await expect(local).toContainText('now covers "ha TAR"')
		await expect(page.getByTestId('collab-offset-selection-drift')).toBeVisible()
		await expect(page.getByTestId('collab-crdt-selection-drift')).toHaveCount(0)
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('a remote prefix edit maps the focused caret with the text while the published offsets stay frozen and drift on both sides', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			await clear(a)
			await expectDocument(b, '')
			const value = 'alpha TARGET omega'
			await a.getByTestId('collab-offset-textarea').fill(value)
			await Promise.all([expectDocument(a, value), expectDocument(b, value)])
			await selectRange(a.getByTestId('collab-offset-textarea'), 6, 12)
			const remoteRow = b.locator('[data-testid="collab-offset-selection-row"][data-local="false"]')
			await expect(remoteRow).toContainText('[6, 12)')

			await b.getByTestId('collab-crdt-textarea').fill(`XX ${value}`)
			await Promise.all([expectDocument(a, `XX ${value}`), expectDocument(b, `XX ${value}`)])

			// The caret is local UX: it rides the splice instead of jumping
			// to the end of the textarea.
			await expect
				.poll(() => a.getByTestId('collab-offset-textarea').evaluate((el) => [el.selectionStart, el.selectionEnd]))
				.toEqual([9, 15])
			// The published range is wire truth: still the frozen numbers,
			// and both tabs' rows say what they now cover instead.
			const localRow = a.locator('[data-testid="collab-offset-selection-row"][data-local="true"]')
			await expect(localRow).toContainText('[6, 12)')
			await expect(localRow).toContainText('now covers "ha TAR"')
			await expect(remoteRow).toContainText('selected "TARGET"')
			await expect(remoteRow).toContainText('now covers "ha TAR"')
			await expect(a.getByTestId('collab-error')).toHaveCount(0)
			await expect(b.getByTestId('collab-error')).toHaveCount(0)
		} finally {
			await confirmAndClick(a.getByTestId('collab-clear'), { timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('two tabs converge bidirectionally on text and character counts, then share a remote Clear', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			await clear(a)
			await expectDocument(b, '')
			const fromA = `from-a-${Date.now()}`
			await a.getByTestId('collab-offset-textarea').fill(fromA)
			await Promise.all([expectDocument(a, fromA), expectDocument(b, fromA)])
			const fromB = `B:${fromA}:done`
			await b.getByTestId('collab-crdt-textarea').fill(fromB)
			await Promise.all([expectDocument(a, fromB), expectDocument(b, fromB)])
			await clear(b)
			await expectDocument(a, '')
			await expect(a.getByTestId('collab-error')).toHaveCount(0)
			await expect(b.getByTestId('collab-error')).toHaveCount(0)
		} finally {
			await confirmAndClick(a.getByTestId('collab-clear'), { timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			await expectTouchTarget(page.getByTestId('collab-clear'))
		} finally {
			await context.close()
		}
	})
})
