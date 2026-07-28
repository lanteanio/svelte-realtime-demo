import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')
const CELL_SELECTOR = '[data-testid^="tick-"]'

test.skip(!process.env.INSTANCE_B, 'chaos cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, baseURL) {
	await page.goto(`${baseURL}/demos/chaos`)
	await waitForWS(page)
}

async function setControls(page, seed, dropRate) {
	await page.getByTestId('seed-input').fill(String(seed))
	await page.getByTestId('drop-rate-input').fill(String(dropRate))
}

async function tickN(page) {
	const text = (await page.getByTestId('counters').textContent())?.trim() ?? ''
	const match = text.match(/^\d+\/(\d+) delivered/)
	expect(match, `unexpected chaos counters: ${text}`).not.toBeNull()
	return Number(match[1])
}

async function pattern(page, count) {
	await expect.poll(() => tickN(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(count)
	const cells = page.getByTestId('decision-strip').locator(CELL_SELECTOR)
	await expect.poll(() => cells.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(count)
	return cells.evaluateAll((nodes, size) => nodes.slice(0, size).map((node) => (
		node.getAttribute('data-testid') === 'tick-dropped' ? 'D' : 'K'
	)).join(''), count)
}

test.describe('cluster: /demos/chaos cross-replica', () => {
	test('one user receives the same deterministic stream across replicas in both directions', async ({ browser }) => {
		// One context deliberately shares the anonymous-user cookie across the two
		// localhost ports. A and B therefore subscribe to the same per-user topic,
		// while their sockets are pinned to different app processes.
		const context = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// Producer state lives on A. B can receive these ticks only through the
			// cross-replica bus because its process never handled startChaos.
			await setControls(a, 7777, 0.5)
			await a.getByTestId('start-button').click()
			const [fromAAtA, fromAAtB] = await Promise.all([pattern(a, 18), pattern(b, 18)])
			expect(fromAAtB).toBe(fromAAtA)
			await a.getByTestId('stop-button').click()
			await expect(a.getByTestId('start-button')).toBeVisible()
			await assertTickerStopped(a, b)
			const [stoppedAtA, stoppedAtB] = await Promise.all([tickN(a), tickN(b)])

			// Reverse the producer. The old keyed cells are replaced from tick 1;
			// first wait for that reset on BOTH replicas so the old 18-cell DOM
			// cannot satisfy the next length gate before the new events arrive.
			await setControls(b, 42, 0.1)
			await b.getByTestId('start-button').click()
			await Promise.all([
				expect.poll(() => tickN(a), { timeout: 10_000 }).toBeLessThan(stoppedAtA),
				expect.poll(() => tickN(b), { timeout: 10_000 }).toBeLessThan(stoppedAtB)
			])
			const [fromBAtA, fromBAtB] = await Promise.all([pattern(a, 18), pattern(b, 18)])
			expect(fromBAtA).toBe(fromBAtB)
			expect(fromBAtB).not.toBe(fromAAtB)
			await b.getByTestId('stop-button').click()
			await expect(b.getByTestId('start-button')).toBeVisible()
			await assertTickerStopped(a, b)
		} finally {
			await context.close()
		}
	})
})

async function assertTickerStopped(...pages) {
	await pages[0].waitForTimeout(250)
	const stopped = await Promise.all(pages.map(tickN))
	await pages[0].waitForTimeout(500)
	const later = await Promise.all(pages.map(tickN))
	expect(later).toEqual(stopped)
}
