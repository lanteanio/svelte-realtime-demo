// Probe: deep diagnostic of cursor smoothness pipeline under 1000-bot load.
//
// Captures:
//   1. WS framereceived intervals on the cursor topic with event-type tag
//   2. Per-frame instance-id distribution (parsed from cursor `key` prefixes)
//   3. requestAnimationFrame intervals in the page
//
// The instance-id breakdown is the key signal: keys are `{instanceId}:{counter}`
// where instanceId is per-worker. A frame from worker app-2 carries only its
// own cursors. The cluster relays cross-replica via Redis pub/sub. If we see
// tight (~1ms) frame pairs whose first frame is all instance-A keys and the
// second is all instance-B keys, the bursty arrival is the cluster fan-out.

import { test, chromium } from '@playwright/test'

test('cursor smoothness probe under 1000-bot load (deep)', async () => {
	test.setTimeout(60_000)

	const browser = await chromium.launch()
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
	const page = await ctx.newPage()

	const start = Date.now()
	const frames = []

	page.on('websocket', (ws) => {
		ws.on('framereceived', (f) => {
			const ts = Date.now() - start
			const payload = f.payload
			if (typeof payload !== 'string') {
				frames.push({ ts, size: payload?.byteLength ?? 0, kind: 'bin' })
				return
			}
			// Need enough of the payload to read event type + sample key prefixes.
			// Parse defensively: payloads can be large.
			let parsed = null
			try { parsed = JSON.parse(payload) } catch { /* not json */ }
			if (!parsed || !parsed.topic) {
				frames.push({ ts, size: payload.length, kind: 'non-topic' })
				return
			}
			if (!parsed.topic.startsWith('__cursor:')) {
				frames.push({ ts, size: payload.length, kind: 'other-topic', topic: parsed.topic })
				return
			}
			const evt = parsed.event
			const instanceIds = new Set()
			let entryCount = 0
			const collectKey = (k) => {
				if (typeof k !== 'string') return
				const colon = k.indexOf(':')
				if (colon > 0) instanceIds.add(k.slice(0, colon))
			}
			if (evt === 'bulk' && Array.isArray(parsed.data)) {
				entryCount = parsed.data.length
				for (const e of parsed.data) collectKey(e?.key)
			} else if (evt === 'update' && parsed.data?.key) {
				entryCount = 1
				collectKey(parsed.data.key)
			} else if (evt === 'catalog' && Array.isArray(parsed.data)) {
				entryCount = parsed.data.length
				for (const e of parsed.data) collectKey(e?.key)
			} else if ((evt === 'join' || evt === 'remove') && parsed.data?.key) {
				entryCount = 1
				collectKey(parsed.data.key)
			}
			frames.push({
				ts,
				size: payload.length,
				kind: 'cursor',
				event: evt,
				entries: entryCount,
				instances: [...instanceIds]
			})
		})
	})

	await page.addInitScript(() => {
		window.__rafIntervals = []
		let last = performance.now()
		const tick = () => {
			const now = performance.now()
			window.__rafIntervals.push(now - last)
			last = now
			if (window.__rafIntervals.length < 20_000) requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	})

	await page.goto('/board/stress-me-out')
	await page.waitForSelector('canvas')

	await page.waitForTimeout(8_000)

	const wsMark = frames.length
	await page.evaluate(() => { window.__rafIntervals.length = 0 })
	const measureStart = Date.now() - start
	console.log(`[probe] steady-state window opens at ${measureStart}ms`)

	const HOLD_MS = 30_000
	await page.waitForTimeout(HOLD_MS)

	const rafIntervals = await page.evaluate(() => window.__rafIntervals.slice())
	const win = frames.slice(wsMark)

	const stats = (arr) => {
		if (arr.length === 0) return null
		const s = arr.slice().sort((a, b) => a - b)
		const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
		return {
			n: arr.length,
			min: +q(0).toFixed(2),
			p50: +q(0.5).toFixed(2),
			p95: +q(0.95).toFixed(2),
			p99: +q(0.99).toFixed(2),
			max: +q(1).toFixed(2),
			mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)
		}
	}

	const cursorFrames = win.filter((f) => f.kind === 'cursor')
	const bulks = cursorFrames.filter((f) => f.event === 'bulk')
	const updates = cursorFrames.filter((f) => f.event === 'update')
	const joins = cursorFrames.filter((f) => f.event === 'join')
	const others = cursorFrames.filter((f) => !['bulk', 'update', 'join', 'catalog', 'remove'].includes(f.event))

	const intervalsOf = (arr) => {
		const r = []
		for (let i = 1; i < arr.length; i++) r.push(arr[i].ts - arr[i - 1].ts)
		return r
	}

	// All cursor frames combined
	const allIntervals = intervalsOf(cursorFrames)
	const bulkIntervals = intervalsOf(bulks)

	// Instance-id distribution across frames
	const instanceCounts = new Map()
	for (const f of cursorFrames) {
		for (const id of (f.instances || [])) {
			instanceCounts.set(id, (instanceCounts.get(id) || 0) + 1)
		}
	}

	// Tight-pair analysis: for each frame within 3ms of the previous, what's
	// the instance overlap?
	const TIGHT_MS = 3
	let tightPairs = 0
	let sameInstancePairs = 0
	let differentInstancePairs = 0
	for (let i = 1; i < cursorFrames.length; i++) {
		const dt = cursorFrames[i].ts - cursorFrames[i - 1].ts
		if (dt > TIGHT_MS) continue
		tightPairs++
		const a = new Set(cursorFrames[i - 1].instances || [])
		const b = new Set(cursorFrames[i].instances || [])
		if (a.size === 0 || b.size === 0) continue
		let overlap = 0
		for (const x of a) if (b.has(x)) overlap++
		if (overlap > 0) sameInstancePairs++
		else differentInstancePairs++
	}

	console.log('\n=== rAF intervals (ms) ===')
	const rafS = stats(rafIntervals)
	console.log(JSON.stringify(rafS, null, 2))
	if (rafS) console.log(`  effective Hz: ${(1000 / rafS.p50).toFixed(1)}`)

	console.log('\n=== Cursor topic frames over %dms ===', HOLD_MS)
	console.log(`  total cursor frames: ${cursorFrames.length} (${(cursorFrames.length / 30).toFixed(1)}/sec)`)
	console.log(`  bulk:   ${bulks.length} (${(bulks.length / 30).toFixed(1)}/sec)`)
	console.log(`  update: ${updates.length} (${(updates.length / 30).toFixed(1)}/sec)`)
	console.log(`  join:   ${joins.length}`)
	console.log(`  other:  ${others.length}`)
	console.log(`  all-cursor intervals: ${JSON.stringify(stats(allIntervals))}`)
	console.log(`  bulk-only intervals:  ${JSON.stringify(stats(bulkIntervals))}`)

	console.log('\n=== Bulk frame entry counts (cursors per frame) ===')
	console.log(JSON.stringify(stats(bulks.map((f) => f.entries))))

	console.log('\n=== Bulk frame sizes (bytes) ===')
	console.log(JSON.stringify(stats(bulks.map((f) => f.size))))

	console.log('\n=== Distinct instance IDs seen across cursor frames ===')
	console.log(`  ${instanceCounts.size} distinct workers; counts:`)
	for (const [id, n] of [...instanceCounts.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`    ${id}: ${n} frames containing this instance`)
	}

	console.log('\n=== Tight-pair analysis (frames within %dms of previous) ===', TIGHT_MS)
	console.log(`  tight pairs:           ${tightPairs}`)
	console.log(`  same-instance pairs:   ${sameInstancePairs}`)
	console.log(`  different-instance:    ${differentInstancePairs}`)
	console.log('  >>> different-instance > same-instance => bursts ARE cross-replica fan-out')

	console.log('\n=== First 6 cursor frames in window ===')
	cursorFrames.slice(0, 6).forEach((f, i) => {
		console.log(`  [${i}] t=${f.ts}ms ${f.event} entries=${f.entries} size=${f.size} instances=[${(f.instances || []).join(',')}]`)
	})

	await browser.close()
})
