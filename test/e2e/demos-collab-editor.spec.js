import { test, expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

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

async function selectRange(locator, start, end) {
	await locator.evaluate((element, range) => {
		element.focus()
		element.setSelectionRange(range.start, range.end)
		element.dispatchEvent(new Event('select', { bubbles: true }))
	}, { start, end })
}

test.describe('/demos/collab-editor', () => {
	test('renders both exact modes, sync/readout state, empty selection guidance, and control constraints', async ({ page }) => {
		await open(page)
		await clear(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Collab editor: selections that survive edits')
		await expect(page.getByTestId('collab-offset-panel')).toContainText("selections: 'offset'")
		await expect(page.getByTestId('collab-crdt-panel')).toContainText("selections: 'crdt'")
		await expect(page.getByTestId('collab-offset-selections-empty')).toBeVisible()
		await expect(page.getByTestId('collab-crdt-selections-empty')).toBeVisible()
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
})
