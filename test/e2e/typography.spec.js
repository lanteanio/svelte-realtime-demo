import { test, expect } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createFreshBoard } from './board-helpers.js'

const demos = fileURLToPath(new URL('../../src/routes/demos/', import.meta.url))
const routes = ['/', ...readdirSync(demos, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => `/demos/${entry.name}`).sort(), '/demos/chat/general']
const scale = { H1: { size: 24, line: 32 }, H2: { size: 18, line: 28 }, H3: { size: 14, line: 20 } }

async function headings(page) {
	return page.locator('h1, h2, h3').evaluateAll((elements) => elements
		.filter((el) => el.getClientRects().length > 0)
		.map((el) => {
			const style = getComputedStyle(el)
			const rect = el.getBoundingClientRect()
			return {
				level: el.tagName, text: el.textContent.trim(),
				size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight),
				client: el.clientWidth, scroll: el.scrollWidth,
				left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth
			}
		}))
}

for (const width of [320, 768, 1366]) {
	test(`server-rendered headings keep the shared scale and fit at ${width}px`, async ({ browser }) => {
		test.setTimeout(180_000)
		const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } })
		const page = await context.newPage()
		const failures = []
		let sections = 0
		try {
			for (const route of routes) {
				const response = await page.goto(route)
				expect(response.status(), route).toBe(200)
				const found = await headings(page)
				expect(found.filter((h) => h.level === 'H1').length, `${route} page title`).toBe(1)
				for (const heading of found) {
					const expected = scale[heading.level]
					if (heading.level === 'H2') sections++
					if (heading.size !== expected.size || heading.line !== expected.line ||
						heading.client <= 0 || heading.scroll > heading.client + 1 ||
						heading.left < -1 || heading.right > heading.viewport + 1) {
						failures.push({ route, ...heading, expected })
					}
				}
			}
		} finally {
			await context.close()
		}
		expect(routes.length, 'the sweep must include every demo').toBeGreaterThan(30)
		expect(sections, 'the sweep must measure section headings').toBeGreaterThan(40)
		expect(failures, 'headings must retain their semantic size and fit their available width').toEqual([])
	})
}

test('the board title uses the page scale without overlapping its controls', async ({ page }) => {
	await createFreshBoard(page, 'A board with a longer title')
	for (const width of [320, 390, 768, 1366]) {
		await page.setViewportSize({ width, height: 900 })
		const title = page.locator('h1')
		await expect(title).toHaveText('A board with a longer title')
		const geometry = await title.evaluate((el) => {
			const rect = el.getBoundingClientRect()
			const style = getComputedStyle(el)
			const others = [...el.parentElement.children].filter((child) => child !== el)
			return {
				size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight),
				width: rect.width, left: rect.left, right: rect.right,
				viewport: document.documentElement.clientWidth,
				overlap: others.some((other) => {
					const box = other.getBoundingClientRect()
					return box.width > 0 && box.height > 0 &&
						Math.min(box.right, rect.right) - Math.max(box.left, rect.left) > 1 &&
						Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) > 1
				})
			}
		})
		expect(geometry.size, `board title at ${width}px`).toBe(24)
		expect(geometry.line).toBe(32)
		expect(geometry.width).toBeGreaterThan(0)
		expect(geometry.left).toBeGreaterThanOrEqual(0)
		expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
		expect(geometry.overlap, `board title overlaps controls at ${width}px`).toBe(false)
		await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeVisible()
	}
})
