import { test, expect } from '@playwright/test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { openTouchPage } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const FAST_TOPIC = 'demos:fromseq:events:fast'

function parseFrame(payload) {
	if (typeof payload !== 'string') return null
	try { return JSON.parse(payload) } catch { return null }
}

// The fromSeq stream's subscribes, the answers to them and the live frames of
// its topic, in the order this page's socket carried them. A subscribe records
// the cursor it resumes from; an answer records the seq it hands back and how
// many events it filled.
function captureFastWire(page) {
	const log = []
	const subscribes = new Map()
	page.on('websocket', (ws) => {
		ws.on('framesent', ({ payload }) => {
			const frame = parseFrame(payload)
			const calls = Array.isArray(frame?.batch) ? frame.batch : [frame]
			for (const call of calls) {
				if (call?.stream !== true || typeof call.rpc !== 'string' || !call.rpc.endsWith('eventStreamFast')) continue
				const entry = { kind: 'subscribe', id: call.id, seq: call.seq ?? null }
				subscribes.set(call.id, entry)
				log.push(entry)
			}
		})
		ws.on('framereceived', ({ payload }) => {
			const frame = parseFrame(payload)
			const envelopes = frame?.type === 'batch' && Array.isArray(frame.events) ? frame.events : [frame]
			for (const envelope of envelopes) {
				if (envelope?.topic === '__rpc') {
					const results = envelope.event === '__batch' && Array.isArray(envelope.data?.batch)
						? envelope.data.batch
						: [{ ...envelope.data, id: envelope.event }]
					for (const result of results) {
						const entry = subscribes.get(result?.id)
						// The attach notice precedes the answer for the same id.
						if (!entry || result.attach === true || entry.answered) continue
						entry.answered = true
						log.push({
							kind: 'answer',
							id: result.id,
							ok: result.ok === true,
							seq: result.seq ?? null,
							fromSeq: result.fromSeq === true,
							count: Array.isArray(result.data) ? result.data.length : null
						})
					}
				} else if (envelope?.topic?.endsWith?.(FAST_TOPIC) && envelope.event === 'created') {
					log.push({ kind: 'live', seq: envelope.seq ?? null, dataSeq: envelope.data?.seq })
				}
			}
		})
	})
	return log
}

async function lastSeq(page) {
	return Math.max(...(await sequences(page)))
}

async function armFastStream(page) {
	await page.getByTestId('fromseq-fast-path').click()
	await expect(page.getByTestId('fromseq-fast-path')).toHaveAttribute('aria-pressed', 'true')
	await expect(page.getByTestId('fromseq-fast-hint')).toContainText('fromSeq stream ready', { timeout: 5_000 })
}

async function setPaused(page, paused) {
	await page.getByTestId('toggle-subscribe').click()
	await expect(page.getByTestId('toggle-subscribe')).toHaveText(paused ? 'Resume subscription' : 'Pause subscription')
}

async function tiersBySeq(page) {
	const rows = await page.getByTestId('event-row').evaluateAll((nodes) => nodes.map((node) => [
		Number(node.textContent?.match(/#(\d+)/)?.[1] ?? NaN),
		node.querySelector('[data-testid^="event-tier-"]')?.textContent?.trim() ?? ''
	]))
	return new Map(rows)
}

// Pause and resume inside one cron tick so the resume misses nothing, then
// pause again before the next tick reaches the page, and return the cursor the
// page held through it. A live event moves the client's cursor forward on its
// own, so an attempt a tick lands in proves nothing about the empty answer and
// is retried.
async function pauseAfterEmptyResume(page, wire) {
	for (let attempt = 1; attempt <= 6; attempt++) {
		const seen = await lastSeq(page)
		// Start right behind a tick, which leaves most of a second for the clicks.
		// A tight interval notices the tick at once; the default backoff can
		// see it up to a second late, with the next tick already close.
		await expect.poll(() => lastSeq(page), { timeout: 4_000, intervals: [25] }).toBeGreaterThan(seen)
		const cursor = await lastSeq(page)
		const filled = await readCount(page, 'tier-fromseq')
		await setPaused(page, true)
		const mark = wire.length
		await setPaused(page, false)
		await expect.poll(() => wire.slice(mark).some((entry) => entry.kind === 'answer'), { timeout: 4_000 }).toBe(true)
		await setPaused(page, true)
		const span = wire.slice(mark)
		const subscribe = span.find((entry) => entry.kind === 'subscribe')
		const answer = span.find((entry) => entry.kind === 'answer')
		const ticked = span.some((entry) => entry.kind === 'live' && entry.dataSeq > cursor)
		if (subscribe?.seq === cursor && answer.ok && answer.fromSeq && answer.count === 0 && !ticked && await lastSeq(page) === cursor) {
			expect(await readCount(page, 'tier-fromseq'), 'an empty answer fills nothing').toBe(filled)
			return cursor
		}
		await setPaused(page, false)
	}
	throw new Error(`no resume inside one tick came back empty: ${JSON.stringify(wire.slice(-16))}`)
}

// After a real gap the resume asks from the cursor the empty answer left in
// place, the bridge fills exactly the events missed since then, and no row the
// page already had is delivered again. A resume from 0 would re-tag the rows
// it already had; one from a counter ahead of the store would fill nothing.
async function expectResumeFrom(page, wire, cursor) {
	await page.waitForTimeout(2_200)
	const had = await tiersBySeq(page)
	const mark = wire.length
	await setPaused(page, false)
	await expect.poll(() => wire.slice(mark).some((entry) => entry.kind === 'answer'), { timeout: 4_000 }).toBe(true)
	const subscribe = wire.slice(mark).find((entry) => entry.kind === 'subscribe')
	const answer = wire.slice(mark).find((entry) => entry.kind === 'answer')
	const trail = JSON.stringify(wire.slice(-16))
	expect(subscribe?.seq, `resume cursor after an empty answer; wire: ${trail}`).toBe(cursor)
	expect(answer.fromSeq && answer.count > 0, `the gap fills through delta.fromSeq; wire: ${trail}`).toBe(true)
	// The answer's seq is its last event. A live event published while the
	// subscribe was in flight can arrive in the answer and again live, and the
	// live copy lands last, so the newest filled row may carry `live`.
	const end = answer.seq
	expect(Number.isSafeInteger(end) && end > cursor, `the fill ends past the cursor; wire: ${trail}`).toBe(true)
	await expect.poll(async () => {
		const now = await tiersBySeq(page)
		for (let seq = cursor + 1; seq <= end; seq++) if (!now.has(seq)) return seq
		return 0
	}, { timeout: 8_000, message: 'first missing seq of the fill' }).toBe(0)
	const filled = [...(await tiersBySeq(page))]
		.filter(([seq, tier]) => tier === 'fromSeq' && !had.has(seq))
		.map(([seq]) => seq)
		.sort((a, b) => a - b)
	expect(filled.length).toBeGreaterThan(0)
	expect(filled).toEqual(filled.map((_, i) => cursor + 1 + i))
	const now = await tiersBySeq(page)
	for (const [seq, tier] of had) expect(now.get(seq), `row #${seq} delivered again`).toBe(tier)
	await expectIntegrity(page)
}

async function readCount(page, testid) {
	const text = (await page.getByTestId(testid).textContent()) ?? ''
	return Number(text.match(/(\d+)/)?.[1] ?? 0)
}

async function sequences(page) {
	return page.getByTestId('event-row').evaluateAll((rows) => rows.map((row) => {
		const match = row.textContent?.match(/#(\d+)/)
		return match ? Number(match[1]) : NaN
	}))
}

// Every row the bridge delivered is one the paused page had not seen, and
// together they cover the gap from the pause point without a hole. A cursor
// behind the pause point would re-tag rows the page already had and fail here.
async function expectGapFilledFrom(page, frozen) {
	const filled = (await page.getByTestId('event-row').evaluateAll((rows) => rows.map((row) => ({
		seq: Number(row.textContent?.match(/#(\d+)/)?.[1] ?? NaN),
		tier: row.querySelector('[data-testid^="event-tier-"]')?.textContent?.trim() ?? ''
	})))).filter((row) => row.tier === 'fromSeq').map((row) => row.seq).sort((a, b) => a - b)
	expect(filled.length).toBeGreaterThan(0)
	expect(filled).toEqual(filled.map((_, i) => frozen + 1 + i))
}

async function expectIntegrity(page) {
	const entries = await page.getByTestId('event-row').evaluateAll((rows) => rows.map((row) => ({
		seq: Number(row.textContent?.match(/#(\d+)/)?.[1] ?? NaN),
		message: row.querySelector('[data-testid="event-message"]')?.textContent?.trim() ?? '',
		tier: row.querySelector('[data-testid^="event-tier-"]')?.textContent?.trim() ?? ''
	})))
	expect(entries.length).toBeGreaterThan(0)
	expect(entries.every((entry) => Number.isFinite(entry.seq))).toBe(true)
	expect(new Set(entries.map((entry) => entry.seq)).size).toBe(entries.length)
	for (let i = 1; i < entries.length; i++) expect(entries[i - 1].seq).toBeGreaterThan(entries[i].seq)
	for (const entry of entries.slice(0, 5)) {
		// The seq lives in its own column; the message renders as the bare
		// phrase with the redundant "#NNNN" suffix stripped.
		expect(entry.message.length).toBeGreaterThan(0)
		expect(entry.message).not.toMatch(/#\d+\s*$/)
		expect(entry.tier).toMatch(/^(live|rehydrate|fromSeq)$/)
	}
}

async function open(page) {
	await page.goto('/demos/from-seq')
	await expect.poll(() => page.getByTestId('event-row').count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
}

test.describe('/demos/from-seq', () => {
	// The events list may only become a nested scroller where it cannot capture
	// a page-scroll gesture. Both halves are asserted independently, because a
	// width-only or pointer-only rule would satisfy one case and still trap the
	// other. Read the COMPUTED style rather than the class attribute: the class
	// list would confirm what was typed, not what the browser resolved.
	async function scrollBox(page) {
		return page.getByTestId('events-list').evaluate((node) => {
			const style = getComputedStyle(node)
			return { maxHeight: style.maxHeight, overflowY: style.overflowY }
		})
	}

	test('the events list never becomes a scroll trap: unbounded when narrow or on touch', async ({ page, browser }) => {
		// Narrow + fine pointer: the reported case. The page must own scrolling.
		await page.setViewportSize({ width: 390, height: 844 })
		await open(page)
		expect(await scrollBox(page), 'narrow viewport must not bound the list').toEqual({
			maxHeight: 'none',
			overflowY: 'visible'
		})

		// Wide + fine pointer: a desktop window, where a bounded region is
		// correct and keeps an unbounded event list from running away.
		await page.setViewportSize({ width: 1440, height: 900 })
		await expect.poll(async () => (await scrollBox(page)).maxHeight).toBe('384px')
		expect(await scrollBox(page)).toEqual({ maxHeight: '384px', overflowY: 'auto' })

		// Wide + COARSE pointer: same width that just bounded the list, so a pass
		// here can only come from the pointer condition. openTouchPage asserts
		// the emulated pointer really is coarse, so this cannot pass vacuously.
		const { context, page: touch } = await openTouchPage(browser, { width: 1440, height: 900 })
		try {
			await open(touch)
			expect(await scrollBox(touch), 'a touch tablet is wide and still must not trap').toEqual({
				maxHeight: 'none',
				overflowY: 'visible'
			})
		} finally {
			await context.close()
		}
	})

	test('renders the complete subscribed state with conserved tier counters and valid event rows', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reconnect: replay buffer or delta.fromSeq gap fill')
		await expect(page.getByTestId('controls-section')).toBeVisible()
		await expect(page.getByTestId('events-section')).toBeVisible()
		await expect(page.getByTestId('toggle-subscribe')).toHaveText('Pause subscription')
		await expect(page.getByTestId('status')).toContainText('status: subscribed')
		await expect(page.getByTestId('tier-live')).toHaveText(/live: \d+/)
		await expect(page.getByTestId('tier-rehydrate')).toHaveText(/rehydrate: \d+/)
		await expect(page.getByTestId('tier-fromseq')).toHaveText(/fromSeq: \d+/)
		await expect(page.getByText(/Replay buffer covers up to 200 events/)).toBeVisible()

		await expect.poll(async () => {
			const [live, rehydrate, fromSeq, rows] = await Promise.all([
				readCount(page, 'tier-live'),
				readCount(page, 'tier-rehydrate'),
				readCount(page, 'tier-fromseq'),
				page.getByTestId('event-row').count()
			])
			return Math.abs(live + rehydrate + fromSeq - rows)
		}).toBeLessThanOrEqual(1)
		await expectIntegrity(page)
	})

	test('Pause freezes rows, shows an advancing countdown/hint, and Resume accounts for every replay badge', async ({ page }) => {
		await open(page)
		await expect.poll(() => readCount(page, 'tier-live'), { timeout: 8_000 }).toBeGreaterThan(0)
		const beforeRehydrate = await readCount(page, 'tier-rehydrate')

		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('toggle-subscribe')).toHaveText('Resume subscription')
		await expect(page.getByTestId('status')).toContainText('status: paused')
		const beforeSeqs = await sequences(page)
		await expect(page.getByTestId('fromseq-hint')).toContainText('200s total')
		await page.waitForTimeout(3_200)
		await expect(page.getByTestId('status')).toContainText(/\([23]s\)/)
		expect(await sequences(page)).toEqual(beforeSeqs)

		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('toggle-subscribe')).toHaveText('Pause subscription')
		await expect(page.getByTestId('status')).toContainText('status: subscribed')
		await expect(page.getByTestId('replay-banner')).toBeVisible({ timeout: 4_000 })
		await expect.poll(() => readCount(page, 'tier-replay'), { timeout: 4_000 }).toBeGreaterThanOrEqual(2)
		const replayCount = await readCount(page, 'tier-replay')
		await expect(page.locator('[data-testid^="event-replay-"]')).toHaveCount(replayCount)
		expect(await readCount(page, 'tier-rehydrate')).toBe(beforeRehydrate)
		await expect.poll(() => page.getByTestId('event-row').count()).toBeGreaterThan(beforeSeqs.length)
		await expectIntegrity(page)
	})

	test('the fromSeq stream fills a two-second gap through delta.fromSeq', async ({ page }) => {
		await open(page)
		const before = await readCount(page, 'tier-fromseq')
		await page.getByTestId('fromseq-fast-path').click()
		await expect(page.getByTestId('fromseq-fast-path')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('fromseq-fast-hint')).toContainText('fromSeq stream ready', { timeout: 5_000 })
		await expect(page.getByTestId('toggle-subscribe')).toBeEnabled()

		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('fromseq-fast-hint')).toContainText('fromSeq stream paused')
		const frozen = Math.max(...(await sequences(page)))
		await page.waitForTimeout(2_200)
		await page.getByTestId('toggle-subscribe').click()
		await expect.poll(() => readCount(page, 'tier-fromseq'), { timeout: 8_000 }).toBeGreaterThan(before)
		await expectGapFilledFrom(page, frozen)
		await expect(page.locator('[data-testid^="event-tier-"]').filter({ hasText: 'fromSeq' }).first()).toBeVisible()
		await expectIntegrity(page)
	})

	// The topic is never published through the replay buffer, so the buffer's
	// counter for it reads 0. A resume that misses nothing must leave the
	// cursor where it was rather than take that counter; from 0, the next
	// resume would ask for the whole store again.
	test('a resume that misses nothing keeps the fromSeq cursor for the next gap', async ({ page }) => {
		test.setTimeout(90_000)
		const wire = captureFastWire(page)
		await open(page)
		await armFastStream(page)
		const cursor = await pauseAfterEmptyResume(page, wire)
		await expectResumeFrom(page, wire, cursor)
	})

	// A buffer counter above the application's seq is the silent case: from
	// there the bridge has nothing to answer, and the events between the real
	// cursor and that counter would never arrive. Live events cannot correct
	// it, since the cursor only moves forward.
	test('a replay counter above the application seq never becomes the fromSeq cursor', async ({ page }) => {
		test.skip(process.env.LOCAL_E2E !== '1', 'seeds the harness Redis, which only the local e2e harness provides')
		const raw = process.env.REDIS_URL
		if (!raw) throw new Error('REDIS_URL is not set; the local e2e harness provides it')
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) throw new Error(`refusing a non-loopback Redis: ${new URL(raw).host}`)
		test.setTimeout(90_000)
		const redis = createRedisClient({ url: raw, autoShutdown: false })
		const counterKey = redis.key('replay:seq:{' + FAST_TOPIC + '}')
		try {
			const appSeq = Number(await redis.redis.get('demos:fromseq:fast:next'))
			expect(Number.isSafeInteger(appSeq) && appSeq > 0).toBe(true)
			await redis.redis.set(counterKey, String(appSeq + 500))
			const wire = captureFastWire(page)
			await open(page)
			await armFastStream(page)
			const cursor = await pauseAfterEmptyResume(page, wire)
			expect(cursor).toBeLessThan(appSeq + 500)
			await expectResumeFrom(page, wire, cursor)
		} finally {
			await redis.redis.del(counterKey).catch(() => {})
			await redis.quit().catch(() => {})
		}
	})

	test('a second tab observes the same sequence while the paused tab catches up without duplicates', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			const beforeA = await sequences(a)
			await a.getByTestId('toggle-subscribe').click()
			await expect(a.getByTestId('status')).toContainText('paused')
			await expect.poll(async () => Math.max(...await sequences(b)), { timeout: 6_000 }).toBeGreaterThan(beforeA[0] + 1)
			expect(await sequences(a)).toEqual(beforeA)
			const target = Math.max(...await sequences(b))
			await a.getByTestId('toggle-subscribe').click()
			await expect(a.getByTestId('replay-banner')).toBeVisible({ timeout: 4_000 })
			await expect.poll(async () => Math.max(...await sequences(a)), { timeout: 4_000 }).toBeGreaterThanOrEqual(target)
			await expectIntegrity(a)
			await expectIntegrity(b)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('a fresh tab rehydrates a bounded recent window and then receives monotonic live ticks', async ({ page }) => {
		await open(page)
		await expect.poll(() => readCount(page, 'tier-rehydrate'), { timeout: 8_000 }).toBeGreaterThan(0)
		expect(await readCount(page, 'tier-rehydrate')).toBeLessThanOrEqual(20)
		const before = Math.max(...await sequences(page))
		await expect.poll(async () => Math.max(...await sequences(page)), { timeout: 4_000 }).toBeGreaterThan(before)
		await expect.poll(() => readCount(page, 'tier-live'), { timeout: 4_000 }).toBeGreaterThan(0)
		await expectIntegrity(page)
	})
})
