// Probe: do cursor frames reach a second tab on /board/stress-me-out?
// Two contexts -> two WS connections -> tab A moves cursor, watch what
// tab B receives on the __cursor: topic.

import { test, chromium } from '@playwright/test'

test('cursor frames cross-tab on stress-me-out', async () => {
	test.setTimeout(60_000)

	const browser = await chromium.launch()
	const ctxA = await browser.newContext()
	const ctxB = await browser.newContext()
	const pageA = await ctxA.newPage()
	const pageB = await ctxB.newPage()

	const start = Date.now()
	const framesA = []
	const framesB = []

	function attach(page, frames, label) {
		page.on('websocket', (ws) => {
			console.log(`[${label}] WS opened: ${ws.url()}`)
			const log = (dir, payload) => {
				const ts = Date.now() - start
				if (typeof payload !== 'string') {
					frames.push({ ts, dir, kind: 'bin', summary: `(${payload.byteLength} bytes)` })
					return
				}
				let raw = null
				try { raw = JSON.parse(payload) } catch { /* not json */ }
				frames.push({ ts, dir, kind: typeof raw === 'object' ? 'json' : 'text', summary: payload.slice(0, 240), raw })
			}
			ws.on('framesent', (f) => log('out', f.payload))
			ws.on('framereceived', (f) => log('in', f.payload))
		})
	}

	attach(pageA, framesA, 'A')
	attach(pageB, framesB, 'B')

	await pageA.goto('/board/stress-me-out')
	await pageB.goto('/board/stress-me-out')

	// Wait for both pages to be on the board and subscriptions to settle
	await pageA.waitForTimeout(3000)

	// Reset frame logs to focus on cursor moves only
	const aMark = framesA.length
	const bMark = framesB.length
	console.log(`pre-cursor frame counts: A=${aMark} B=${bMark}`)

	// Move cursor in tab A across the canvas
	const canvasA = await pageA.locator('canvas').first()
	const boxA = await canvasA.boundingBox()
	if (!boxA) throw new Error('no canvas in A')
	for (let i = 0; i < 8; i++) {
		await pageA.mouse.move(boxA.x + 50 + i * 30, boxA.y + 50 + i * 20, { steps: 4 })
		await pageA.waitForTimeout(60)
	}

	await pageA.waitForTimeout(500)

	// Inspect frames since the mark
	const aNew = framesA.slice(aMark)
	const bNew = framesB.slice(bMark)

	console.log(`\n=== A outgoing (after move) ===`)
	for (const f of aNew) {
		if (f.dir !== 'out') continue
		const s = f.summary
		if (s.includes('moveCursor') || s.includes('cursor')) {
			console.log(`  [${f.ts}ms] OUT ${s}`)
		}
	}

	console.log(`\n=== A incoming __cursor frames ===`)
	let aCursorIn = 0
	for (const f of aNew) {
		if (f.dir !== 'in') continue
		const s = f.summary
		if (s.includes('__cursor') || s.includes('"cursor"')) {
			aCursorIn++
			if (aCursorIn <= 5) console.log(`  [${f.ts}ms] IN  ${s.slice(0, 200)}`)
		}
	}
	console.log(`  total A __cursor inbound frames: ${aCursorIn}`)

	console.log(`\n=== B incoming __cursor frames ===`)
	let bCursorIn = 0
	for (const f of bNew) {
		if (f.dir !== 'in') continue
		const s = f.summary
		if (s.includes('__cursor') || s.includes('"cursor"')) {
			bCursorIn++
			if (bCursorIn <= 5) console.log(`  [${f.ts}ms] IN  ${s.slice(0, 200)}`)
		}
	}
	console.log(`  total B __cursor inbound frames: ${bCursorIn}`)

	console.log(`\n=== B incoming __presence frames (control: this should work) ===`)
	let bPresenceIn = 0
	for (const f of bNew) {
		if (f.dir !== 'in') continue
		if (f.summary.includes('__presence')) {
			bPresenceIn++
			if (bPresenceIn <= 3) console.log(`  [${f.ts}ms] IN  ${f.summary.slice(0, 180)}`)
		}
	}
	console.log(`  total B __presence inbound frames: ${bPresenceIn}`)

	await browser.close()
})
