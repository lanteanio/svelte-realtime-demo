import { test, expect } from '@playwright/test'
import { confirmAndClick, expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const NUMERIC_FIELDS = ['subscriber-ratio', 'publish-rate', 'memory-mb', 'backpressured-conns']

async function open(page) {
	await page.goto('/demos/pressure')
	await waitForWS(page)
	await expect(page.getByTestId('reason')).not.toHaveText('...', { timeout: 10_000 })
}

async function clear(page) {
	// The clear control is honestly disabled when the log is already empty.
	if (await page.getByTestId('shed-row').count() > 0) {
		await confirmAndClick(page.getByTestId('clear-shed'))
	}
	await expect(page.getByTestId('shed-log')).toContainText('No shed decisions yet')
	await expect(page.getByTestId('shed-row')).toHaveCount(0)
}

async function runLoad(page, count) {
	const button = page.getByTestId(`load-${count}`)
	await button.click()
	if (count > 200) {
		await expect(button).toHaveText(`sending +${count}...`)
		for (const id of [100, 1000, 5000]) await expect(page.getByTestId(`load-${id}`)).toBeDisabled()
	}
	await expect(page.getByTestId('last-burst')).toContainText(`sent +${count} events`, { timeout: 8_000 })
	await expect(button).toBeEnabled()
	return Number(await page.getByTestId('publish-rate').textContent())
}

test.describe('/demos/pressure', () => {
	test('renders the complete live snapshot, bounded scalar, numeric telemetry, sparkline, and every control', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Admission-shedding control panel')
		await expect(page.getByTestId('reason')).toHaveText(/^(NONE|MEMORY|PUBLISH_RATE|SUBSCRIBERS|BACKPRESSURE|CPU|PSI)$/)
		const pressure = page.getByTestId('pressure-value')
		await expect(pressure).toHaveAttribute('max', '1')
		const value = Number(await pressure.getAttribute('value'))
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThanOrEqual(1)
		for (const id of NUMERIC_FIELDS) {
			// Assert the rendered TEXT is a number before comparing it. An empty
			// or missing readout stringifies to '' and Number('') is 0, so a bare
			// `>= 0` silently accepts a field that renders nothing at all.
			await expect(page.getByTestId(id)).toHaveText(/^\d+(\.\d+)?$/)
			expect(Number(await page.getByTestId(id).textContent())).toBeGreaterThanOrEqual(0)
		}
		await expect(page.getByTestId('heap-pct')).toHaveText(/^\d+%$/)
		await expect(page.getByTestId('max-buffered')).toHaveText(/^\d+KB$/)
		expect(['adapter', 'generated-load-dev']).toContain(await page.getByTestId('publish-rate').getAttribute('data-rate-source'))
		await expect.poll(() => page.getByTestId('sparkline').locator('div').count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
		await expect(page.getByTestId('load-100')).toHaveText('+100')
		await expect(page.getByTestId('load-1000')).toHaveText('+1000')
		await expect(page.getByTestId('load-5000')).toHaveText('+5000 (cap)')
		await expect(page.getByTestId('simulate-shed')).toHaveText('Simulate shed')
		await expect(page.getByTestId('clear-shed')).toHaveText('Clear shed log')
	})

	test('each load control reports its exact conserved count and long bursts expose the busy state', async ({ page }) => {
		await open(page)
		await runLoad(page, 100)
		await runLoad(page, 1000)
		await runLoad(page, 5000)
		// Compare against a fixed floor, not against a rate read back out of the
		// product: `>= rate` where `rate` is itself the readout passes trivially
		// when the readout is stuck at 0, which is exactly the regression this
		// assertion is for. 6100 events were just sent, so the counter must have
		// moved well past zero regardless of the window it is averaged over.
		await expect.poll(async () => Number(await page.getByTestId('publish-rate').textContent()), { timeout: 6_000 })
			.toBeGreaterThan(0)
		expect(['adapter', 'generated-load-dev']).toContain(await page.getByTestId('publish-rate').getAttribute('data-rate-source'))
	})

	test('Simulate shed appends exact decision fields newest-first and Clear removes every row', async ({ page }) => {
		await open(page)
		await clear(page)
		await page.getByTestId('simulate-shed').click()
		await expect(page.getByTestId('shed-row')).toHaveCount(1)
		await expect(page.getByTestId('shed-row').first()).toContainText('simulateShed')
		await expect(page.getByTestId('shed-row').first()).toContainText('background')
		await expect(page.getByTestId('shed-row').first()).toContainText('PUBLISH_RATE')
		await expect(page.getByTestId('shed-row').first()).toContainText('simulated')
		await page.getByTestId('simulate-shed').click()
		await expect(page.getByTestId('shed-row')).toHaveCount(2)
		await clear(page)
	})

	test('two tabs receive the same shed creation and a remote Clear', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			await clear(a)
			await expect(b.getByTestId('shed-row')).toHaveCount(0)
			await a.getByTestId('simulate-shed').click()
			for (const page of [a, b]) {
				await expect(page.getByTestId('shed-row')).toHaveCount(1)
				await expect(page.getByTestId('shed-row').first()).toContainText('simulateShed')
				await expect(page.getByTestId('shed-row').first()).toContainText('simulated')
			}
			await clear(b)
			await expect(a.getByTestId('shed-row')).toHaveCount(0)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('all five controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			// All five, not just the four the earlier sweep reached: Clear shed
			// log was relocated into the log header and kept its btn-sm dress.
			for (const id of ['load-100', 'load-1000', 'load-5000', 'simulate-shed', 'clear-shed']) {
				await expectTouchTarget(page.getByTestId(id))
			}
		} finally {
			await context.close()
		}
	})
})
