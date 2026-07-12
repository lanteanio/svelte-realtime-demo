import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Single-page assertions only: the document is shared global state, so
// these tests verify the local surface (editing round-trips through the
// CRDT replica, selection reporting does not crash). Multi-tab selection
// sync is covered by the cluster tiers.
test.describe('/demos/collab-editor', () => {
	test('page loads with both panels and the shared readouts', async ({ page }) => {
		await page.goto('/demos/collab-editor')
		await waitForWS(page)

		await expect(page.getByTestId('collab-offset-panel')).toBeVisible()
		await expect(page.getByTestId('collab-crdt-panel')).toBeVisible()
		await expect(page.getByTestId('collab-offset-textarea')).toBeVisible()
		await expect(page.getByTestId('collab-crdt-textarea')).toBeVisible()
		await expect(page.getByTestId('collab-offset-selections')).toBeVisible()
		await expect(page.getByTestId('collab-crdt-selections')).toBeVisible()
		await expect(page.getByTestId('collab-doc-length')).toBeVisible()
		await expect(page.getByTestId('collab-clear')).toBeVisible()

		// The doc sync exchange completes on the open connection.
		await expect(page.getByTestId('collab-doc-synced')).toHaveText('synced', { timeout: 10_000 })
	})

	test('typing in one panel updates the shared document and the other panel', async ({ page }) => {
		await page.goto('/demos/collab-editor')
		await waitForWS(page)
		await expect(page.getByTestId('collab-doc-synced')).toHaveText('synced', { timeout: 10_000 })

		const token = `edit-${Date.now()}`
		await page.getByTestId('collab-clear').click()
		await expect(page.getByTestId('collab-offset-textarea')).toHaveValue('', { timeout: 5_000 })

		// fill() dispatches one input event with the full value; the page
		// diffs it against the replica and applies the minimal splice.
		await page.getByTestId('collab-offset-textarea').fill(token)

		// Both textareas render the same doc.text('body') facet, so the
		// write must be visible in the CRDT panel and the length readout.
		await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(token, { timeout: 5_000 })
		await expect(page.getByTestId('collab-doc-length')).toHaveText(`${token.length} chars`, { timeout: 5_000 })
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
	})

	test('selecting text in the same tab reports without crashing (both modes)', async ({ page }) => {
		await page.goto('/demos/collab-editor')
		await waitForWS(page)
		await expect(page.getByTestId('collab-doc-synced')).toHaveText('synced', { timeout: 10_000 })

		const token = `select-me-${Date.now()}`
		await page.getByTestId('collab-offset-textarea').fill(token)
		await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(new RegExp(token), { timeout: 5_000 })

		// Offset mode publishes raw { start, end }.
		await page.getByTestId('collab-offset-textarea').selectText()
		// CRDT mode anchors { field, start, end } into the bound doc.
		await page.getByTestId('collab-crdt-textarea').selectText()

		// Own selections are self-excluded from the remote views; the only
		// observable single-tab contract is "no error, page still live".
		await page.waitForTimeout(500)
		await expect(page.getByTestId('collab-error')).toHaveCount(0)
		await expect(page.getByTestId('collab-offset-textarea')).toBeEditable()
		await expect(page.getByTestId('collab-crdt-textarea')).toBeEditable()
	})
})
