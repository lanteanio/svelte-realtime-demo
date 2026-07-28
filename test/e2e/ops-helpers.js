import { expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

export async function openOps(page, target = '/demos/ops') {
	await page.goto(target)
	await waitForWS(page)
	await expect(page.getByTestId('ops-headline-card')).toBeVisible()
	await expect(page.getByTestId('ops-refreshed-at')).not.toHaveText('loading...', { timeout: 15_000 })
	await expect.poll(() => integer(page, 'ops-handlers-total'), { timeout: 15_000 }).toBeGreaterThan(0)
}

export async function integer(page, testId) {
	return Number((await page.getByTestId(testId).textContent())?.trim())
}

export async function replicaId(page) {
	await expect(page.getByTestId('ops-replica')).toContainText('reading replica', { timeout: 15_000 })
	const id = await page.getByTestId('ops-replica').locator('[data-instance-id]').getAttribute('data-instance-id')
	expect(id).toMatch(/^[0-9a-f]{6,}$/)
	return id
}

export async function handlerKinds(page) {
	return page.getByTestId('ops-handlers-kinds').locator('li').evaluateAll((rows) => Object.fromEntries(rows.map((row) => {
		const cells = row.querySelectorAll('span')
		return [cells[0]?.textContent?.trim() ?? '', Number(cells[1]?.textContent?.trim())]
	})))
}

export async function dlqState(page) {
	const total = await integer(page, 'ops-dlq-total')
	const byTopic = await page.getByTestId('ops-dlq-topic-row').evaluateAll((rows) => Object.fromEntries(rows.map((row) => {
		const cells = row.querySelectorAll('td')
		return [cells[0]?.textContent?.trim() ?? '', Number(cells[1]?.textContent?.trim())]
	})))
	return { total, byTopic }
}

export function topicTotal(state, topic) {
	return state.byTopic[topic] ?? 0
}

export async function expectDlqConsistent(page) {
	const state = await dlqState(page)
	expect(Number.isInteger(state.total)).toBe(true)
	expect(state.total).toBeGreaterThanOrEqual(0)
	for (const count of Object.values(state.byTopic)) {
		expect(Number.isInteger(count)).toBe(true)
		expect(count).toBeGreaterThan(0)
	}
	expect(Object.values(state.byTopic).reduce((sum, count) => sum + count, 0)).toBe(state.total)
	if (state.total === 0) await expect(page.getByTestId('ops-dlq-empty')).toBeVisible()
	else await expect(page.getByTestId('ops-dlq-by-topic')).toBeVisible()
	return state
}
