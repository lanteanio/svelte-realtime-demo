// Tiny probe that captures one full cursor BULK frame and prints the
// raw JSON so we can analyse the wire shape and quantify optimization
// potential. Runs against the live demo; assumes a destroyer is
// already feeding the board.

import { test, chromium } from '@playwright/test'

test('capture one cursor bulk frame', async () => {
	test.setTimeout(45_000)
	const browser = await chromium.launch()
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
	const page = await ctx.newPage()

	let captured = null
	page.on('websocket', (ws) => {
		ws.on('framereceived', (f) => {
			if (captured) return
			const p = f.payload
			if (typeof p !== 'string') return
			if (!p.includes('"event":"bulk"')) return
			if (!p.includes('__cursor:')) return
			captured = p
		})
	})

	await page.goto('/board/stress-me-out')
	await page.waitForSelector('canvas')
	for (let i = 0; i < 60 && !captured; i++) await page.waitForTimeout(500)

	console.log('=== RAW BULK FRAME ===')
	console.log(captured || '(none captured)')
	if (captured) {
		try {
			const parsed = JSON.parse(captured)
			const entryCount = Array.isArray(parsed.data) ? parsed.data.length : 0
			console.log('=== STATS ===')
			console.log('total bytes:', captured.length)
			console.log('entries:', entryCount)
			console.log('bytes per entry:', entryCount > 0 ? (captured.length / entryCount).toFixed(2) : 'n/a')
			if (entryCount > 0) {
				const sample = parsed.data[0]
				console.log('sample entry:', JSON.stringify(sample))
				console.log('sample entry bytes:', JSON.stringify(sample).length)
			}
		} catch (e) { console.log('parse error:', e.message) }
	}
	await browser.close()
})
