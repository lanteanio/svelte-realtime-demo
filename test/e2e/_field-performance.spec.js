import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test('opt-in collection exports aggregate browser performance without identity fields', async ({ page }) => {
	const apiResponses = []
	page.on('response', response => {
		if (response.url().includes('/api/field-performance')) apiResponses.push([response.request().method(), response.status()])
	})
	page.on('pageerror', error => apiResponses.push(['pageerror', error.message]))
	const rejected = await page.request.post('/api/field-performance', {
		data: { schemaVersion: 1, identity: 'visitor-id' }
	})
	expect(rejected.status()).toBe(400)
	const direct = await page.request.post('/api/field-performance', {
		data: {
			schemaVersion: 1, device: 'desktop', connection: 'unknown',
			metrics: {
				lcp: { eligible: true, value: 1000 },
				inp: { eligible: false, value: null },
				cls: { eligible: true, value: 0 }
			}
		}
	})
	expect(direct.status()).toBe(202)

	await page.goto('/')
	await waitForWS(page)
	await page.waitForLoadState('networkidle')
	await page.getByPlaceholder("Filter demos (try 'lock', 'push', 'cron')...").fill('counter')
	await page.locator('label.swap').click()
	const beacon = page.waitForResponse(response => response.url().includes('/api/field-performance') && response.request().method() === 'POST')
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
	expect((await beacon).status()).toBe(202)

	let output
	await expect.poll(async () => {
		const response = await page.request.get('/api/field-performance', {
			headers: { 'x-scrape-token': process.env.METRICS_SCRAPE_TOKEN }
		})
		if (response.status() !== 200) return 0
		output = await response.json()
		return output.segments.reduce((total, segment) => total + segment.navigationCount, 0)
	}).toBe(2, JSON.stringify(apiResponses))
	expect(output.schemaVersion).toBe(1)
	expect(output.datasetKind).toBe('field')
	expect(output.coverage.geography).toEqual(['unknown'])
	const segment = output.segments.find(row => row.connection === '4g')
	expect(segment.navigationCount).toBe(1)
	expect(segment.metrics.lcp.eligibleCount).toBe(1)
	expect(segment.metrics.inp.eligibleCount).toBe(0)
	expect(segment.metrics.cls.eligibleCount).toBe(1)
	expect(segment.metrics.inp.distribution).toEqual([])
	expect(JSON.stringify(output)).not.toContain('identity')
	expect(JSON.stringify(output)).not.toContain('visitor-id')
})
