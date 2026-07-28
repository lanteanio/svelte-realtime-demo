import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export const DEMO_SLUGS = [
	'checkout', 'counter-resume', 'chat', 'todos-rollback', 'denials', 'pressure',
	'chaos', 'notifications', 'topk', 'news', 'jobs', 'cluster-cron', 'upload',
	'auctions', 'schema-evolution', 'flash-sales', 'pagination', 'effect', 'from-seq',
	'collab-editor', 'multiplayer', 'kanban', 'offline', 'arena', 'shooter', 'lobbies',
	'tenants', 'flags', 'alarms', 'forget', 'privacy', 'ops', 'outbound-webhooks', 'phases'
]

export const VERSION_06_SLUGS = new Set([
	'collab-editor', 'multiplayer', 'kanban', 'offline', 'arena', 'shooter', 'lobbies',
	'tenants', 'flags', 'alarms', 'forget', 'privacy', 'ops', 'outbound-webhooks', 'phases'
])

export const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff']

export async function openHome(page, origin = '') {
	await page.goto(`${origin}/`)
	await waitForWS(page)
	await expect(page.getByRole('heading', { name: 'Boards', exact: true })).toBeVisible()
	await expect(page.getByTestId('demos-filter-count')).toHaveText(`${DEMO_SLUGS.length} / ${DEMO_SLUGS.length}`)
}

export function demoTile(page, slug) {
	return page.getByTestId(`demos-tile-${slug}`)
}

export function boardCard(page, path) {
	return page.locator(`a.card[href="${path}"]`)
}

export async function createBoardFromHome(page, title, method = 'button') {
	const input = page.getByPlaceholder('New board name...')
	await input.fill(title)
	if (method === 'enter') await input.press('Enter')
	else await page.getByRole('button', { name: 'Create', exact: true }).click()
	await page.waitForURL(/\/board\//, { timeout: 15_000 })
	await expect(page.locator('h1')).toHaveText(title, { timeout: 15_000 })
	return new URL(page.url()).pathname
}

export async function expectBoardCard(page, path, title) {
	const card = boardCard(page, path)
	await expect(card).toBeVisible({ timeout: 15_000 })
	await expect(card.locator('span.font-medium')).toHaveText(title)
	return card
}

export async function expectBoardPresence(page, path, count) {
	const card = boardCard(page, path)
	await expect(card).toBeVisible({ timeout: 15_000 })
	const badge = card.locator('.badge-primary')
	if (count === 0) await expect(badge).toHaveCount(0, { timeout: 15_000 })
	else await expect(badge).toHaveText(`${count} here`, { timeout: 15_000 })
}

export async function navbarIdentity(page) {
	const text = (await page.locator('.navbar .font-medium').textContent())?.trim() ?? ''
	const cookie = (await page.context().cookies()).find((entry) => entry.name === 'identity')
	if (!cookie) throw new Error('identity cookie is missing')
	return { text, token: cookie.value, cookie }
}

export async function navigateHome(page) {
	await page.locator('.navbar a[href="/"]').click()
	await page.waitForURL(/\/$/)
	await expect(page.getByRole('heading', { name: 'Boards', exact: true })).toBeVisible()
}
