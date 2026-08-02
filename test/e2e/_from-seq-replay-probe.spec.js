// Probe: does the replay buffer actually engage on pause+resume within a
// single WS connection? Captures all WS frames so we can see what the
// server actually sends back when the client resubscribes.
//
// Run against the prod build on localhost:3001:
//   BASE_URL=http://localhost:3001 npx playwright test e2e/_from-seq-replay-probe.spec.js --reporter=list

import { test, expect } from '@playwright/test'

/**
 * Wait until the rehydrate tier stops moving, and report where it stopped.
 *
 * Settling is the property the demo actually promises. The absolute count is
 * a function of cron phase, which no part of the harness controls, so an
 * equality assertion here is really an assertion about timing dressed up as
 * one about behaviour.
 *
 * The floor is only `> 0`: this is a diagnostic probe, its subject is the
 * pause and resume further down, and a larger floor would reintroduce exactly
 * the arbitrary threshold this replaced.
 */
async function settleRehydrate(page, { stableSamples = 3, intervalMs = 500, timeout = 20_000 } = {}) {
	const read = async () => {
		const text = await page.getByTestId('tier-rehydrate').textContent()
		const found = /rehydrate:\s*(\d+)/.exec(text ?? '')
		return found ? Number(found[1]) : null
	}
	const deadline = Date.now() + timeout
	let previous = null
	let stable = 0
	while (Date.now() < deadline) {
		const value = await read()
		if (value !== null && value > 0 && value === previous) {
			if (++stable >= stableSamples) return value
		} else {
			stable = 0
		}
		previous = value
		await page.waitForTimeout(intervalMs)
	}
	throw new Error(`rehydrate count never settled above zero within ${timeout}ms (last read: ${previous})`)
}

test('from-seq pause+resume captures wire frames', async ({ page }) => {
	test.setTimeout(60_000)

	/** @type {Array<{ dir: 'in' | 'out', kind: string, summary: string, raw: any, ts: number }>} */
	const frames = []
	const startedAt = Date.now()

	page.on('websocket', (ws) => {
		const url = ws.url()
		// eslint-disable-next-line no-console
		console.log('[probe] WS opened:', url)

		const log = (dir, payload) => {
			const ts = Date.now() - startedAt
			let kind = 'binary'
			let summary = '(binary)'
			let raw = null
			if (typeof payload === 'string') {
				try {
					raw = JSON.parse(payload)
					if (Array.isArray(raw)) {
						// Batched frame
						kind = 'batch[' + raw.length + ']'
						summary = raw.map((m) => m?.rpc || m?.topic || m?.event || '?').slice(0, 4).join(',')
					} else if (raw && typeof raw === 'object') {
						kind = raw.rpc ? 'rpc' : raw.topic ? 'topic' : raw.event ? 'evt' : 'json'
						summary = JSON.stringify(raw).slice(0, 200)
					} else {
						kind = 'json'
						summary = payload.slice(0, 200)
					}
				} catch {
					kind = 'text'
					summary = payload.slice(0, 200)
				}
			} else if (payload && payload.byteLength !== undefined) {
				kind = 'binary'
				summary = `(${payload.byteLength} bytes)`
			}
			frames.push({ dir, kind, summary, raw, ts })
		}

		ws.on('framesent', (f) => log('out', f.payload))
		ws.on('framereceived', (f) => log('in', f.payload))
	})

	await page.goto('/demos/from-seq')

	// Wait for the initial rehydrate to FINISH, which is not the same as it
	// reaching any particular number. The count is however many events the
	// replay buffer holds when the page opens, and that depends on how long
	// the 1Hz cron has been ticking: run-local-e2e gates each tier on the cron
	// having STARTED, never on it having produced a given number of events.
	// This previously asserted exactly 20 and a run settled at 16 and held
	// there, so the probe failed here and never reached the pause and resume
	// it exists to observe. Four seconds of cron drift was enough to hide the
	// probe's entire subject.
	const rehydrated = await settleRehydrate(page)
	console.log('[probe] initial rehydrate complete at', rehydrated, 'events')

	// Let a few live events flow in
	await page.waitForTimeout(4000)
	const liveBefore = await page.getByTestId('tier-live').textContent()
	console.log('[probe] live count before pause:', liveBefore)

	// Capture the highest seq currently on screen via the first rendered row
	const newestSeqText = await page.locator('[data-testid="events-list"] [data-testid="event-row"]').first().locator('span').nth(1).textContent()
	const pausedAtSeq = Number((newestSeqText || '').replace('#', '').trim())
	console.log('[probe] pausedAtSeq:', pausedAtSeq)

	const beforePauseMark = frames.length
	console.log('[probe] frames before pause:', beforePauseMark)

	// Pause
	await page.getByTestId('toggle-subscribe').click()
	await expect(page.getByTestId('status')).toContainText('paused')
	console.log('[probe] paused at frame index', frames.length)

	// Wait 6 seconds while paused
	await page.waitForTimeout(6000)
	const beforeResumeMark = frames.length
	console.log('[probe] frames after 6s pause:', beforeResumeMark)

	// Resume
	await page.getByTestId('toggle-subscribe').click()
	await expect(page.getByTestId('status')).toContainText('subscribed')
	console.log('[probe] resumed at frame index', frames.length)

	// Let gap-fill arrive
	await page.waitForTimeout(2500)

	const liveAfter = await page.getByTestId('tier-live').textContent()
	console.log('[probe] live count after resume:', liveAfter)

	// Replay banner present?
	const banner = await page.getByTestId('replay-banner').count()
	console.log('[probe] replay-banner count:', banner)

	// Print frames around the pause/resume
	console.log('\n========== FRAMES AROUND PAUSE ==========')
	for (let i = Math.max(0, beforePauseMark - 4); i < frames.length; i++) {
		const f = frames[i]
		const marker = i === beforePauseMark ? '  ⬇ PAUSE CLICK ⬇' : i === beforeResumeMark ? '  ⬇ RESUME CLICK ⬇' : ''
		console.log(`  [${f.ts.toString().padStart(5)}ms] ${f.dir.toUpperCase()} ${f.kind.padEnd(10)} ${f.summary}${marker}`)
	}

	console.log('\n========== OUTBOUND RPC SUMMARY ==========')
	for (const f of frames) {
		if (f.dir === 'out' && f.raw) {
			if (Array.isArray(f.raw)) {
				for (const m of f.raw) {
					if (m?.rpc && m.rpc.includes('from-seq')) {
						console.log(`  [${f.ts}ms] OUT rpc=${m.rpc} stream=${m.stream} seq=${m.seq} id=${m.id}`)
					}
				}
			} else if (f.raw.rpc && f.raw.rpc.includes('from-seq')) {
				console.log(`  [${f.ts}ms] OUT rpc=${f.raw.rpc} stream=${f.raw.stream} seq=${f.raw.seq} id=${f.raw.id}`)
			}
		}
	}

	console.log('\n========== INBOUND STREAM RESPONSES ==========')
	for (const f of frames) {
		if (f.dir === 'in' && f.raw) {
			const items = Array.isArray(f.raw) ? f.raw : [f.raw]
			for (const m of items) {
				// Stream subscribe response
				if (m && m.id !== undefined && m.ok !== undefined && (m.topic || '').includes('fromseq')) {
					console.log(`  [${f.ts}ms] IN response id=${m.id} ok=${m.ok} seq=${m.seq} replay=${m.replay} dataLen=${Array.isArray(m.data) ? m.data.length : 'n/a'}`)
					if (Array.isArray(m.data) && m.data.length > 0) {
						const seqs = m.data.map((d) => d.seq).slice(0, 30)
						const tiers = [...new Set(m.data.map((d) => d.tier))]
						console.log(`    -> seqs: [${seqs.join(',')}] tiers: [${tiers.join(',')}]`)
					}
				}
				// Pushed publish event
				if (m && (m.topic || '').includes('fromseq') && m.event) {
					console.log(`    [${f.ts}ms] PUSH topic=${m.topic} event=${m.event} seq=${m.data?.seq} tier=${m.data?.tier}`)
				}
			}
		}
	}

	expect(frames.length).toBeGreaterThan(0)
})
