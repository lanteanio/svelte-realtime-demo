import { test, expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const STAT_IDS = ['pending', 'running', 'committed', 'failed', 'total']

async function expectStats(page, expected) {
	for (const id of STAT_IDS) {
		if (id in expected) {
			await expect(page.getByTestId(`stat-${id}`)).toHaveText(String(expected[id]))
		}
	}
}

async function clearJobs(page) {
	await confirmAndClick(page.getByTestId('jobs-clear-button'))
	await expect(page.getByTestId('jobs-list-empty')).toBeVisible({ timeout: 5_000 })
	await expectStats(page, { pending: 0, running: 0, committed: 0, failed: 0, total: 0 })
}

async function gotoFreshJobs(page) {
	await page.goto('/demos/jobs')
	await waitForWS(page)
	const unavailable = page.getByTestId('jobs-unavailable')
	if (await unavailable.isVisible().catch(() => false)) {
		test.skip(true, 'DATABASE_URL not configured; /demos/jobs requires Postgres')
	}
	await expect(page.getByTestId('jobs-enqueue-form')).toBeVisible()
	await clearJobs(page)
}

async function setDuration(page, seconds) {
	const slider = page.getByTestId('jobs-duration-input')
	await slider.fill(String(seconds))
	await slider.dispatchEvent('change')
	await expect(page.getByText(`Duration (${Number(seconds).toFixed(1)}s)`, { exact: true })).toBeVisible()
}

async function enqueue(page, { duration = 0.4, mode = 'succeed' } = {}) {
	await setDuration(page, duration)
	await page.getByTestId('jobs-mode-input').selectOption(mode)
	await page.getByTestId('jobs-enqueue-button').click()
	const row = page.getByTestId('jobs-row').first()
	await expect(row).toBeVisible({ timeout: 8_000 })
	await expect(row).toContainText(`${Number(duration).toFixed(1)}s / ${mode}`)
	return row
}

test.describe('/demos/jobs', () => {
	test('renders exact empty stats, slider bounds, all modes, fence state, and controls', async ({ page }) => {
		await gotoFreshJobs(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs: durable task runner with fence + retry + force-takeover')
		await expect(page.getByTestId('jobs-stats-strip')).toBeVisible()
		await expect(page.getByTestId('jobs-list')).toBeVisible()
		await expect(page.getByTestId('jobs-list-empty')).toContainText('No tasks yet. Enqueue one above - try a 10s duration')

		const slider = page.getByTestId('jobs-duration-input')
		await expect(slider).toHaveAttribute('min', '0.4')
		await expect(slider).toHaveAttribute('max', '15')
		await expect(slider).toHaveAttribute('step', '0.1')
		await setDuration(page, 15)
		await setDuration(page, 0.4)

		const mode = page.getByTestId('jobs-mode-input')
		expect(await mode.locator('option').allTextContents()).toEqual(['succeed', 'fail-once', 'fail-always'])
		await expect(page.getByTestId('jobs-enqueue-button')).toBeEnabled()
		await expect(page.getByTestId('jobs-clear-button')).toBeEnabled()
		await expect(page.getByTestId('fence-status')).toHaveText(/^(enabled|disabled \(no REDIS_URL\))$/)
	})

	test('succeed commits on attempt 1 with exact list and stats accounting', async ({ page }) => {
		await gotoFreshJobs(page)
		const row = await enqueue(page)
		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 10_000 })
		await expect(row.getByTestId('jobs-row-status')).toHaveText('committed')
		await expect(row.getByTestId('jobs-row-result')).toHaveText(/ok in \d+ms \(attempt 1\)/)
		await expect(page.getByTestId('jobs-row')).toHaveCount(1)
		await expectStats(page, { pending: 0, running: 0, committed: 1, failed: 0, total: 1 })
	})

	test('fail-once retries exactly once and commits on attempt 2', async ({ page }) => {
		await gotoFreshJobs(page)
		const row = await enqueue(page, { mode: 'fail-once' })
		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 14_000 })
		await expect(row.getByTestId('jobs-row-result')).toHaveText(/ok in \d+ms \(attempt 2\)/)
		await expectStats(page, { committed: 1, failed: 0, total: 1 })
	})

	test('fail-always exhausts all three attempts and exposes the terminal error', async ({ page }) => {
		await gotoFreshJobs(page)
		const row = await enqueue(page, { mode: 'fail-always' })
		await expect(row).toHaveAttribute('data-status', 'failed', { timeout: 16_000 })
		await expect(row.getByTestId('jobs-row-status')).toHaveText('failed')
		await expect(row).toContainText('attempt 3')
		await expect(row.getByTestId('jobs-row-error')).toContainText('intentional always-fail')
		await expectStats(page, { pending: 0, running: 0, committed: 0, failed: 1, total: 1 })
	})

	test('force takeover aborts a running fence and commits a later attempt', async ({ page }) => {
		await gotoFreshJobs(page)
		const row = await enqueue(page, { duration: 4 })
		await expect(row).toHaveAttribute('data-status', 'running', { timeout: 8_000 })
		await expect(row.getByTestId('jobs-row-takeover')).toBeVisible()
		await row.getByTestId('jobs-row-takeover').click()
		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 20_000 })
		await expect(row.getByTestId('jobs-row-result')).toHaveText(/ok in \d+ms \(attempt [2-9]\)/)
		await expectStats(page, { committed: 1, total: 1 })
	})

	test('clear removes a running row, resets every stat, and it does not reappear', async ({ page }) => {
		await gotoFreshJobs(page)
		const row = await enqueue(page, { duration: 4 })
		await expect(row).toHaveAttribute('data-status', 'running', { timeout: 8_000 })
		await clearJobs(page)
		await page.waitForTimeout(2_500)
		await expect(page.getByTestId('jobs-list-empty')).toBeVisible()
		await expectStats(page, { pending: 0, running: 0, committed: 0, failed: 0, total: 0 })
	})

	test('two tabs converge on enqueue, completion, stats, and a remote clear', async ({ browser }) => {
		const context = await browser.newContext()
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await gotoFreshJobs(a)
			await b.goto('/demos/jobs')
			await waitForWS(b)
			await expect(b.getByTestId('jobs-list-empty')).toBeVisible()
			const rowA = await enqueue(a)
			const rowB = b.getByTestId('jobs-row').first()
			await expect(rowA).toHaveAttribute('data-status', 'committed', { timeout: 10_000 })
			await expect(rowB).toHaveAttribute('data-status', 'committed', { timeout: 10_000 })
			await expectStats(a, { committed: 1, total: 1 })
			await expectStats(b, { committed: 1, total: 1 })
			await clearJobs(b)
			await expect(a.getByTestId('jobs-list-empty')).toBeVisible({ timeout: 5_000 })
			await expectStats(a, { total: 0 })
		} finally {
			await context.close()
		}
	})

	test('liveness stays honest before any stats snapshot arrives', async ({ page }) => {
		// Let the socket connect and the page subscribe for real, but drop every
		// stats snapshot on the way back. The store still emits its initial
		// undefined synchronously at subscribe time - the moment the defect
		// stamped as a live tick - while no actual snapshot ever lands, so the
		// readout must keep saying it is waiting.
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((message) => server.send(message))
			server.onMessage((message) => {
				if (String(message).includes('demos:jobs:stats')) return
				ws.send(message)
			})
		})
		await page.goto('/demos/jobs')
		await waitForWS(page)
		const tick = page.getByTestId('jobs-last-tick')
		await expect(tick).toBeVisible()
		// Well past several 1Hz ticks, so a stamp would certainly have appeared.
		await page.waitForTimeout(2_500)
		await expect(tick).toHaveText('waiting for the first 1Hz tick...')
		await expect(tick).not.toContainText('last tick')
	})

	test('a failed Clear all reports next to the list, not in the enqueue form', async ({ page }) => {
		await gotoFreshJobs(page)

		// Drop the socket the moment the clear RPC goes out, so the in-flight
		// call rejects for real rather than being simulated.
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((message) => {
				if (String(message).includes('clear')) {
					ws.close()
					return
				}
				server.send(message)
			})
			server.onMessage((message) => ws.send(message))
		})
		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('jobs-enqueue-form')).toBeVisible()

		await confirmAndClick(page.getByTestId('jobs-clear-button'))

		const clearError = page.getByTestId('jobs-clear-error')
		await expect(clearError).toBeVisible({ timeout: 15_000 })
		await expect(clearError).not.toHaveText('')
		// The enqueue form's own error slot must stay empty: routing a clear
		// failure there was the defect.
		await expect(page.getByTestId('jobs-error')).toHaveCount(0)
		// And the message belongs to the list card that owns the control.
		await expect(page.getByTestId('jobs-list').getByTestId('jobs-clear-error')).toBeVisible()
	})
})
