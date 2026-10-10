import { test, expect } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boardCanvas, boardNotes, createFreshBoard } from './board-helpers.js'
import { waitForWS } from './helpers.js'
import { freshTableId, joinById, openLobbies } from './lobbies-helpers.js'
import { openOps } from './ops-helpers.js'

const demos = fileURLToPath(new URL('../../src/routes/demos/', import.meta.url))
const routes = ['/', ...readdirSync(demos, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => `/demos/${entry.name}`).sort(), '/demos/chat/general']
const scale = {
	H1: { size: 24, line: 32, weight: 700 },
	H2: { size: 18, line: 28, weight: 600 },
	H3: { size: 14, line: 20, weight: 600 }
}

async function headings(locator) {
	return locator.evaluateAll((elements) => elements
		.filter((el) => el.getClientRects().length > 0)
		.map((el) => {
			const style = getComputedStyle(el)
			const rect = el.getBoundingClientRect()
			const brokenWords = []
			const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
			while (walker.nextNode()) {
				const node = walker.currentNode
				for (const word of node.textContent.matchAll(/[A-Za-z0-9]{2,}/g)) {
					const range = document.createRange()
					range.setStart(node, word.index)
					range.setEnd(node, word.index + word[0].length)
					const lines = new Set([...range.getClientRects()]
						.filter((box) => box.width > 0 && box.height > 0)
						.map((box) => Math.round(box.top * 2) / 2))
					if (lines.size > 1) brokenWords.push(word[0])
				}
			}
			return {
				level: el.tagName, text: el.textContent.trim(),
				size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight),
				weight: Number.parseFloat(style.fontWeight), brokenWords,
				client: el.clientWidth, scroll: el.scrollWidth,
				left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth
			}
		}))
}

function fitsScale(heading) {
	const expected = scale[heading.level]
	return heading.size === expected.size && heading.line === expected.line && heading.weight === expected.weight &&
		heading.brokenWords.length === 0 && heading.client > 0 && heading.scroll <= heading.client + 1 &&
		heading.left >= -1 && heading.right <= heading.viewport + 1
}

for (const width of [320, 768, 1366]) {
	test(`server-rendered headings keep whole words and the shared scale at ${width}px`, async ({ browser }) => {
		test.setTimeout(180_000)
		const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } })
		const page = await context.newPage()
		const failures = []
		let sections = 0
		try {
			for (const route of routes) {
				const response = await page.goto(route)
				expect(response.status(), route).toBe(200)
				const found = await headings(page.locator('h1, h2, h3'))
				expect(found.filter((h) => h.level === 'H1').length, `${route} page title`).toBe(1)
				for (const heading of found) {
					if (heading.level === 'H2') sections++
					if (!fitsScale(heading)) failures.push({ route, ...heading, expected: scale[heading.level] })
				}
			}
		} finally {
			await context.close()
		}
		expect(routes.length, 'the sweep must include every demo').toBeGreaterThan(30)
		expect(sections, 'the sweep must measure section headings').toBeGreaterThan(40)
		expect(failures, 'headings must retain their scale, fit and avoid splitting words').toEqual([])
	})
}

async function boardGeometry(page) {
	return boardCanvas(page).evaluate((canvas) => {
		const title = document.querySelector('h1')
		const box = title.getBoundingClientRect()
		const style = getComputedStyle(title)
		const text = document.createRange()
		text.selectNodeContents(title)
		const textBoxes = [...text.getClientRects()]
		const header = document.querySelector('[data-testid="board-add-note"]').parentElement
		const otherChildren = [...header.children].filter((child) => !child.contains(title))
		const canvasBox = canvas.getBoundingClientRect()
		const tickerBox = canvas.nextElementSibling.getBoundingClientRect()
		return {
			size: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight),
			weight: Number.parseFloat(style.fontWeight),
			fullTextVisible: textBoxes.length > 0 && textBoxes.every((rect) =>
				rect.left >= box.left - 1 && rect.right <= box.right + 1 &&
				rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
			left: box.left, right: box.right, viewportWidth: document.documentElement.clientWidth,
			overlap: otherChildren.some((other) => {
				const rect = other.getBoundingClientRect()
				return rect.width > 0 && rect.height > 0 &&
					Math.min(rect.right, box.right) - Math.max(rect.left, box.left) > 1 &&
					Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) > 1
			}),
			canvasHeight: canvasBox.height, canvasBottom: canvasBox.bottom, tickerTop: tickerBox.top,
			tickerBottom: tickerBox.bottom, viewportHeight: window.innerHeight,
			documentHeight: document.documentElement.scrollHeight
		}
	})
}

async function expectBoardFit(page, label) {
	const geometry = await boardGeometry(page)
	expect(geometry.size, label).toBe(24)
	expect(geometry.line, label).toBe(32)
	expect(geometry.weight, label).toBe(700)
	expect(geometry.fullTextVisible, `full board name is visibly rendered: ${label}`).toBe(true)
	expect(geometry.left, label).toBeGreaterThanOrEqual(0)
	expect(geometry.right, label).toBeLessThanOrEqual(geometry.viewportWidth)
	expect(geometry.overlap, `board title overlaps controls: ${label}`).toBe(false)
	expect(geometry.canvasHeight, label).toBeGreaterThan(0)
	expect(geometry.canvasBottom, `canvas extends behind activity: ${label}`).toBeLessThanOrEqual(geometry.tickerTop + 1)
	expect(Math.abs(geometry.tickerBottom - geometry.viewportHeight), `activity stays at viewport bottom: ${label}`).toBeLessThanOrEqual(1)
	expect(geometry.documentHeight, `board extends below viewport: ${label}`).toBeLessThanOrEqual(geometry.viewportHeight + 1)
}

for (const hasTouch of [false, true]) {
	test(`the full board name and canvas fit with ${hasTouch ? 'coarse' : 'fine'} controls`, async ({ browser }) => {
		const context = await browser.newContext({ hasTouch })
		const page = await context.newPage()
		try {
			await createFreshBoard(page, 'A board with a longer title')
			for (const viewport of [
				{ width: 320, height: 568 }, { width: 390, height: 844 },
				{ width: 768, height: 1024 }, { width: 1366, height: 900 }
			]) {
				await page.setViewportSize(viewport)
				await page.evaluate(() => window.scrollTo(0, 0))
				await expect(page.locator('h1')).toHaveText('A board with a longer title')
				await expectBoardFit(page, `${viewport.width}px, touch=${hasTouch}`)
				await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeInViewport()
			}
		} finally {
			await context.close()
		}
	})
}

test('a keyboard visitor can rename a board and add a note without losing the canvas', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 })
	await createFreshBoard(page, 'A board with a longer title')
	const rename = page.getByRole('button', { name: 'Rename board', exact: true })
	await rename.focus()
	await rename.press('Enter')
	const input = page.getByRole('textbox', { name: 'Board name', exact: true })
	await expect(input).toBeFocused()
	await input.fill('A renamed board with a longer title')
	await input.press('Enter')
	await expect(page.locator('h1')).toHaveText('A renamed board with a longer title')
	await expect(rename).toBeFocused()
	await page.getByRole('button', { name: 'Add note', exact: true }).press('Enter')
	await expect(boardNotes(page)).toHaveCount(1)
	await expectBoardFit(page, 'after keyboard rename and note activity')
})

test('headings revealed by live data retain the scale and whole words', async ({ page }) => {
	test.setTimeout(90_000)
	await page.setViewportSize({ width: 320, height: 900 })
	const found = []
	async function capture(locator) {
		await expect(locator).toBeVisible()
		const measured = await headings(locator)
		expect(measured).toHaveLength(1)
		found.push(...measured)
	}
	await openLobbies(page)
	await joinById(page, freshTableId())
	await capture(page.getByTestId('lob-table-title'))
	await page.getByTestId('lob-leave').click()
	await expect(page.getByTestId('lob-table-title')).toHaveCount(0)
	await page.goto('/demos/schema-evolution')
	await waitForWS(page)
	await capture(page.getByRole('heading', { level: 3, name: /What migrate\[1\] does to a row/ }))
	await page.goto('/demos/denials')
	await waitForWS(page)
	await capture(page.getByRole('heading', { level: 2, name: /^Recent denials/ }))
	await openOps(page)
	await capture(page.getByTestId('ops-handlers-card').locator('h2'))
	await capture(page.getByTestId('ops-dlq-card').locator('h2'))
	expect(found).toHaveLength(5)
	expect(found.filter((heading) => !fitsScale(heading)), 'hydrated headings must retain their readable hierarchy').toEqual([])
})

test('long homepage and demo content still scrolls with the document', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 })
	for (const route of ['/', '/demos/topk']) {
		await page.goto(route)
		await waitForWS(page)
		const lastHeading = page.locator('h1, h2, h3').last()
		await lastHeading.scrollIntoViewIfNeeded()
		await expect(lastHeading).toBeInViewport()
		expect(await page.evaluate(() => window.scrollY), `${route} keeps document scrolling`).toBeGreaterThan(0)
	}
})
