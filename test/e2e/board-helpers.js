import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export function boardCanvas(page) {
	return page.locator('div.relative.w-full.overflow-auto')
}

export function boardNotes(page) {
	return page.locator('.absolute.w-52')
}

export function noteWithText(page, text) {
	return boardNotes(page).filter({ hasText: text })
}

export async function openBoard(page, target) {
	await page.goto(target)
	await waitForWS(page)
	// No .catch here: a board still showing its spinner after 15s is a real
	// failure, and swallowing it turned this readiness gate into a no-op that
	// handed a half-loaded page to every assertion downstream.
	await page.locator('.loading').first().waitFor({ state: 'hidden', timeout: 15_000 })
	await expect(page.locator('h1')).toBeVisible({ timeout: 15_000 })
	await expect(boardCanvas(page)).toBeVisible()
}

export async function createFreshBoard(page, title, origin = '') {
	await page.goto(`${origin}/`)
	await waitForWS(page)
	await page.getByPlaceholder('New board name...').fill(title)
	await page.getByRole('button', { name: 'Create', exact: true }).click()
	await page.waitForURL(/\/board\//, { timeout: 15_000 })
	// No .catch here: a board still showing its spinner after 15s is a real
	// failure, and swallowing it turned this readiness gate into a no-op that
	// handed a half-loaded page to every assertion downstream.
	await page.locator('.loading').first().waitFor({ state: 'hidden', timeout: 15_000 })
	await expect(page.locator('h1')).toHaveText(title, { timeout: 15_000 })
	return new URL(page.url()).pathname
}

export async function expectOnline(page, count) {
	await expect(page.locator('.text-xs.opacity-50').filter({ hasText: new RegExp(`^${count} online$`) })).toHaveCount(1, { timeout: 15_000 })
}

export async function createNoteAt(page, x, y) {
	const notes = boardNotes(page)
	const before = await notes.count()
	const canvas = boardCanvas(page)
	const box = await canvas.boundingBox()
	if (!box) throw new Error('board canvas has no bounding box')
	await page.mouse.dblclick(box.x + x, box.y + y)
	await expect(notes).toHaveCount(before + 1, { timeout: 15_000 })
	return notes.nth(before)
}

export async function editNote(note, text, exit = 'blur') {
	await note.dblclick({ force: true })
	const textarea = note.locator('textarea')
	await expect(textarea).toBeVisible()
	await textarea.fill(text)
	if (exit === 'escape') await textarea.press('Escape')
	else await textarea.blur()
	await expect(note.locator('p')).toHaveText(text, { timeout: 10_000 })
}

export async function setNoteColor(note, color) {
	await note.hover({ force: true })
	await note.getByLabel('Pick color').click({ force: true })
	await expect(note.getByLabel(/Set color to #/)).toHaveCount(6)
	await note.getByLabel(`Set color to ${color}`).click({ force: true })
	const hex = color.replace('#', '')
	const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
	const pattern = new RegExp(`${hex}|rgb\\(${rgb[0]},\\s*${rgb[1]},\\s*${rgb[2]}\\)`, 'i')
	await expect.poll(() => note.evaluate((element) => element.style.background)).toMatch(pattern)
}

export async function deleteNote(note) {
	await note.hover({ force: true })
	await note.getByLabel('Delete note').click({ force: true })
	await expect(note).toHaveCount(0, { timeout: 15_000 })
}

export async function dragNote(page, note, dx, dy) {
	const before = await notePosition(note)
	const box = await note.boundingBox()
	if (!box) throw new Error('note has no bounding box')
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + dx, y + dy, { steps: 12 })
	await page.mouse.up()
	await expect.poll(async () => (await notePosition(note)).left, { timeout: 15_000 }).toBeGreaterThan(before.left + dx - 15)
	return notePosition(note)
}

export async function notePosition(note) {
	return note.evaluate((element) => ({
		left: Number.parseInt(element.style.left, 10),
		top: Number.parseInt(element.style.top, 10),
		z: Number.parseInt(element.style.zIndex, 10) || 0,
		background: element.style.background
	}))
}

export async function positions(page) {
	return boardNotes(page).evaluateAll((elements) => elements.map((element) => ({
		left: Number.parseInt(element.style.left, 10),
		top: Number.parseInt(element.style.top, 10),
		z: Number.parseInt(element.style.zIndex, 10) || 0
	})))
}

export async function clickFabAction(page, label) {
	await page.locator('.fab-trigger').focus()
	const button = page.locator(`[data-tip="${label}"] button`)
	await expect(button).toBeVisible()
	await button.click()
}

export function activityTicker(page) {
	return page.locator('.fixed.bottom-0')
}

export function boardCard(page, path) {
	return page.locator(`a.card[href="${path}"]`)
}

export async function expectCardPresence(page, path, count) {
	const card = boardCard(page, path)
	await expect(card).toBeVisible({ timeout: 15_000 })
	const badge = card.locator('.badge-primary')
	if (count === 0) await expect(badge).toHaveCount(0, { timeout: 15_000 })
	else await expect(badge).toHaveText(`${count} here`, { timeout: 15_000 })
}

export async function moveBoardCursor(page, x, y) {
	const canvas = boardCanvas(page)
	const box = await canvas.boundingBox()
	if (!box) throw new Error('board canvas has no bounding box')
	await page.mouse.move(box.x + x, box.y + y, { steps: 10 })
}

export async function overlayHasInk(page, x, y) {
	const overlay = page.locator('canvas.absolute.pointer-events-none')
	await expect(overlay).toBeVisible()
	return overlay.evaluate((canvas, point) => {
		const context = canvas.getContext('2d')
		const dpr = canvas.width / canvas.clientWidth || 1
		const sx = Math.max(0, Math.floor((point.x - 3) * dpr))
		const sy = Math.max(0, Math.floor((point.y - 3) * dpr))
		const width = Math.min(canvas.width - sx, Math.ceil(120 * dpr))
		const height = Math.min(canvas.height - sy, Math.ceil(35 * dpr))
		if (width <= 0 || height <= 0) return false
		const pixels = context.getImageData(sx, sy, width, height).data
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) return true
		return false
	}, { x, y })
}
