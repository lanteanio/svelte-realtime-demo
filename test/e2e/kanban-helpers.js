import { expect } from '@playwright/test'
import { confirmAndClick } from './helpers.js'

export async function openKanban(page, url = '/demos/kanban') {
	await page.goto(url)
	await expect(page.getByTestId('kb-synced-badge')).toBeVisible({ timeout: 15_000 })
}

export function card(page, id) {
	return page.getByTestId(`kb-card-${id}`)
}

export function cardTitle(page, id) {
	return page.getByTestId(`kb-title-${id}`)
}

export async function findCardId(page, title) {
	return page.locator('[data-testid^="kb-card-"]').evaluateAll((nodes, expected) => {
		const found = nodes.find((node) => node.querySelector('input')?.value === expected)
		return found?.getAttribute('data-testid')?.slice('kb-card-'.length) ?? ''
	}, title)
}

export async function waitForCard(page, title) {
	await expect.poll(() => findCardId(page, title), { timeout: 10_000 }).not.toBe('')
	return findCardId(page, title)
}

export async function addCard(page, column, title, submitWithEnter = false) {
	const input = page.getByTestId(`kb-add-input-${column}`)
	const button = page.getByTestId(`kb-add-button-${column}`)
	await input.fill(title)
	await expect(button).toBeEnabled()
	if (submitWithEnter) await input.press('Enter')
	else await button.click()
	const id = await waitForCard(page, title)
	await expect(input).toHaveValue('')
	await expect(button).toBeDisabled()
	await waitInColumn(page, id, column)
	return id
}

export async function waitInColumn(page, id, column) {
	await expect(page.getByTestId(`kb-cards-${column}`).getByTestId(`kb-card-${id}`)).toBeVisible({ timeout: 10_000 })
	for (const other of ['todo', 'doing', 'done'].filter((candidate) => candidate !== column)) {
		await expect(page.getByTestId(`kb-cards-${other}`).getByTestId(`kb-card-${id}`)).toHaveCount(0)
	}
}

export async function renameCard(page, id, title) {
	await cardTitle(page, id).fill(title)
	// Renames commit on blur/Enter so remote edits cannot clobber the caret.
	await cardTitle(page, id).press('Enter')
	await expect(cardTitle(page, id)).toHaveValue(title)
}

export async function moveCard(page, id, direction, destination) {
	await page.getByTestId(`kb-move-${direction}-${id}`).click()
	await waitInColumn(page, id, destination)
}

export async function deleteCard(page, id) {
	if (await card(page, id).count() === 0) return
	await confirmAndClick(page.getByTestId(`kb-delete-${id}`))
	await expect(card(page, id)).toHaveCount(0, { timeout: 10_000 })
}

export async function assertColumnCount(page, column) {
	const cards = await page.getByTestId(`kb-cards-${column}`).locator('[data-testid^="kb-card-"]').count()
	await expect(page.getByTestId(`kb-count-${column}`)).toHaveText(String(cards))
}
