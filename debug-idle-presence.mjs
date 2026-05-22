// Tests user hypothesis: fresh connect, wait 2 min idle, does presence drop?
// maxAge is 90s on the client; server should send heartbeats every 30s
// to keep entries fresh. If heartbeats are missing or filtered, the
// presence entries expire and counts drop.

import { chromium } from 'playwright'

const TARGET = 'https://svelte-realtime-demo.lantean.io/board/stress-me-out'

const browser = await chromium.launch()

const heartbeats = { A: 0, B: 0 }
const diffs = { A: 0, B: 0 }

async function open(label) {
	const ctx = await browser.newContext()
	const page = await ctx.newPage()
	page.on('pageerror', (err) => console.log(`[${label} pageerror]`, err.message))
	page.on('websocket', (ws) => {
		ws.on('framereceived', (f) => {
			const s = f.payload?.toString() ?? ''
			if (s.includes('"event":"heartbeat"') && s.includes('__presence:')) {
				heartbeats[label]++
			}
			if (s.includes('"event":"presence_diff"')) diffs[label]++
		})
	})
	await page.goto(TARGET)
	return page
}

async function readBoardCount(page) {
	// Board PresenceBar shows e.g. "2 online" next to the avatars
	const all = await page.locator('span.text-xs').filter({ hasText: /\d+ online/ }).allTextContents()
	return all
}

console.log('Opening A...')
const a = await open('A')
await new Promise((r) => setTimeout(r, 4000))

console.log('Opening B...')
const b = await open('B')
await new Promise((r) => setTimeout(r, 4000))

console.log('\n[t=0] initial state:')
console.log('  A:', await readBoardCount(a))
console.log('  B:', await readBoardCount(b))

const waitMs = Number(process.env.WAIT_MS ?? 130_000) // 2:10 default
const checkEvery = 20_000
const start = Date.now()
let t = 0
while (Date.now() - start < waitMs) {
	const remaining = waitMs - (Date.now() - start)
	await new Promise((r) => setTimeout(r, Math.min(checkEvery, remaining)))
	t = Date.now() - start
	console.log(`\n[t=${(t/1000)|0}s] heartbeats A=${heartbeats.A} B=${heartbeats.B}, diffs A=${diffs.A} B=${diffs.B}`)
	console.log('  A:', await readBoardCount(a))
	console.log('  B:', await readBoardCount(b))
}

await browser.close()
