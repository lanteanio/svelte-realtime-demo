import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export function freshTableId() {
	return String(1_000_000 + Math.floor(Math.random() * 8_000_000))
}

export async function openLobbies(page, target = '/demos/lobbies') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lobbies: browse, own, share')
}

export function roomRow(page, id) {
	return page.getByTestId(`lob-room-${id}`)
}

export async function joinById(page, id) {
	await page.getByTestId('lob-new-id').fill(id)
	await page.getByTestId('lob-create').click()
	await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`, { timeout: 15_000 })
}

export async function joinByCode(page, code, id) {
	await page.getByTestId('lob-code-input').fill(code)
	await page.getByTestId('lob-code-join').click()
	await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`, { timeout: 15_000 })
	await expect(page.getByTestId('lob-code-input')).toHaveValue('')
}

export async function joinFromRow(page, id) {
	const row = roomRow(page, id)
	await expect(row).toBeVisible({ timeout: 15_000 })
	await row.getByTestId(`lob-room-join-${id}`).click()
	await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`, { timeout: 15_000 })
	await expect(row.getByTestId(`lob-room-join-${id}`)).toBeDisabled()
}

export async function shareCode(page, id) {
	const code = (await roomRow(page, id).getByTestId('lob-room-code').textContent())?.trim() ?? ''
	expect(code).toMatch(/^[0-9A-Za-z]{6}$/)
	return code
}

export async function expectMembership(page, id, count) {
	await expect(page.getByTestId('lob-presence').locator('li')).toHaveCount(count, { timeout: 15_000 })
	await expect(roomRow(page, id).getByTestId('lob-room-count')).toHaveText(`${count}/8`, { timeout: 15_000 })
}

export async function expectTableGone(page, id) {
	await expect(page.getByTestId('lob-table-title')).toHaveCount(0)
	await expect(roomRow(page, id)).toHaveCount(0, { timeout: 15_000 })
}

export async function sendMessage(page, text, method = 'button') {
	const input = page.getByTestId('lob-composer-input')
	await input.fill(text)
	if (method === 'enter') await input.press('Enter')
	else await page.getByTestId('lob-send').click()
	await expect(input).toHaveValue('')
}

export function message(page, text) {
	return page.getByTestId('lob-msg').filter({ hasText: text })
}

export async function expectNoLobbyErrors(...pages) {
	for (const page of pages) {
		await expect(page.getByTestId('lob-error')).toHaveCount(0)
		await expect(page.locator('.alert-warning')).toHaveCount(0)
	}
}
