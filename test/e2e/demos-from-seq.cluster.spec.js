import { test, expect } from '@playwright/test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'from-seq cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/from-seq`)
	await expect.poll(() => page.getByTestId('event-row').count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
}

async function rows(page) {
	return page.getByTestId('event-row').evaluateAll((nodes) => nodes.map((node) => {
		const seq = Number(node.textContent?.match(/#(\d+)/)?.[1] ?? NaN)
		const message = node.querySelector('[data-testid="event-message"]')?.textContent?.trim() ?? ''
		// The RAW stored epoch-ms, not the rendered clock text. `timeOf` formats
		// with toLocaleTimeString, which drops milliseconds, so two genuinely
		// different durable rows written inside the same second render as the
		// same string - an equality on that text would agree across replicas
		// that had loaded different rows.
		const ts = Number(node.querySelector('[data-testid="event-time"]')?.getAttribute('data-ts') ?? NaN)
		return { seq, message, ts }
	}))
}

async function readCount(page, id) {
	// NaN, not 0, when the badge does not render. Two zero sentinels compare
	// equal, so an unchanged-value assertion would pass against a page that
	// stopped rendering tier counters entirely.
	const match = ((await page.getByTestId(id).textContent()) ?? '').match(/(\d+)/)
	return match ? Number(match[1]) : Number.NaN
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

// Live frames of the fromSeq topic as this page's socket received them: the
// wire seq the client resumes from, next to the seq the cron put in the event.
function captureFastFrames(page) {
	const frames = []
	page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
		if (typeof payload !== 'string') return
		let frame
		try { frame = JSON.parse(payload) } catch { return }
		const events = frame?.type === 'batch' && Array.isArray(frame.events) ? frame.events : [frame]
		for (const event of events) {
			if (typeof event?.topic === 'string' && event.topic.endsWith('demos:fromseq:events:fast') && event.event === 'created') {
				frames.push({ seq: event.seq, dataSeq: event.data?.seq })
			}
		}
	}))
	return frames
}

function assertIntegrity(entries) {
	expect(entries.length).toBeGreaterThan(0)
	expect(entries.every((entry) => Number.isFinite(entry.seq))).toBe(true)
	expect(new Set(entries.map((entry) => entry.seq)).size).toBe(entries.length)
	for (let i = 1; i < entries.length; i++) expect(entries[i - 1].seq).toBeGreaterThan(entries[i].seq)
	for (const entry of entries) {
		// The seq owns a dedicated column, so the message renders as the bare
		// phrase with its redundant "#NNNN" suffix stripped. Requiring the
		// suffix here asserted a wire field against an element that never
		// carried it, which fails on every row the page has ever rendered.
		expect(entry.message.length).toBeGreaterThan(0)
		expect(entry.message).not.toMatch(/#\d+\s*$/)
		// A stored timestamp, not a placeholder: finite, and inside a plausible
		// epoch-ms window. A missing attribute is NaN and fails here rather than
		// reaching the cross-replica equality, where it would compare NaN to NaN.
		expect(Number.isFinite(entry.ts)).toBe(true)
		expect(entry.ts).toBeGreaterThan(1_700_000_000_000)
		expect(entry.ts).toBeLessThan(Date.now() + 60_000)
	}
	// One writer at 1Hz, so every retained row carries its own timestamp. A
	// constant that happens to be finite and in range would survive every check
	// above on its own; it cannot survive this one.
	expect(new Set(entries.map((entry) => entry.ts)).size).toBe(entries.length)
}

test.describe('cluster: /demos/from-seq', () => {
	test('separate replicas load identical durable events and share one monotonic sequence', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			const [rowsA, rowsB] = await Promise.all([rows(a), rows(b)])
			assertIntegrity(rowsA)
			assertIntegrity(rowsB)
			const bySeqB = new Map(rowsB.map((entry) => [entry.seq, entry]))
			const overlap = rowsA.filter((entry) => bySeqB.has(entry.seq))
			// More than one, so a single coincidental row cannot carry the claim.
			expect(overlap.length).toBeGreaterThan(1)
			for (const entry of overlap) {
				const mirror = bySeqB.get(entry.seq)
				expect(mirror.message).toBe(entry.message)
				// The stored epoch-ms is the one field a replica cannot recompute
				// from the seq in front of it: the phrase is a pure function of the
				// seq, so comparing only that would agree even between replicas
				// reading entirely different stores. This value is written once, by
				// the leader-elected cron, into the shared durable row, so matching
				// it to the millisecond is what makes this an agreement check.
				expect(mirror.ts).toBe(entry.ts)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('a paused replica freezes while the other advances, then replay catches it up', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await a.getByTestId('toggle-subscribe').click()
			await expect(a.getByTestId('status')).toContainText('paused')
			const frozen = await rows(a)
			await expect.poll(async () => Math.max(...(await rows(b)).map((entry) => entry.seq)), { timeout: 6_000 })
				.toBeGreaterThan(frozen[0].seq + 1)
			expect(await rows(a)).toEqual(frozen)
			const target = Math.max(...(await rows(b)).map((entry) => entry.seq))
			await a.getByTestId('toggle-subscribe').click()
			await expect(a.getByTestId('replay-banner')).toBeVisible({ timeout: 4_000 })
			await expect.poll(() => readCount(a, 'tier-replay'), { timeout: 4_000 }).toBeGreaterThanOrEqual(2)
			await expect.poll(async () => Math.max(...(await rows(a)).map((entry) => entry.seq)), { timeout: 4_000 })
				.toBeGreaterThanOrEqual(target)
			assertIntegrity(await rows(a))
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('the fromSeq stream carries one sequence to both replicas and fills a gap on the other one', async ({ browser }) => {
		test.skip(process.env.LOCAL_E2E !== '1', 'seeds the harness Redis, which only the local e2e harness provides')
		const raw = process.env.REDIS_URL
		if (!raw) throw new Error('REDIS_URL is not set; the local e2e harness provides it')
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) throw new Error(`refusing a non-loopback Redis: ${new URL(raw).host}`)
		// Move the application counter far past anything an adapter's own
		// per-topic counter reaches in one run, so a wire seq equal to the
		// event's seq can only be the one the cron stamped explicitly.
		const SEED = 1_000_000
		const redis = createRedisClient({ url: raw, autoShutdown: false })
		try {
			await redis.redis.incrby('demos:fromseq:fast:next', SEED)
		} finally {
			await redis.quit().catch(() => {})
		}

		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const framesA = captureFastFrames(a)
		const framesB = captureFastFrames(b)
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			for (const page of [a, b]) {
				await page.getByTestId('fromseq-fast-path').click()
				await expect(page.getByTestId('fromseq-fast-hint')).toContainText('fromSeq stream ready', { timeout: 5_000 })
			}
			// Live frames past the seed on both replicas, each stamped with the
			// event's own seq, and the same events seen on both.
			await expect.poll(() => framesB.filter((frame) => frame.dataSeq > SEED).length, { timeout: 6_000 }).toBeGreaterThanOrEqual(2)
			const seeded = [...framesA, ...framesB].filter((frame) => frame.dataSeq > SEED)
			expect(seeded.length).toBeGreaterThan(0)
			for (const frame of seeded) expect(frame.seq).toBe(frame.dataSeq)
			const seenOnA = new Set(framesA.map((frame) => frame.dataSeq))
			expect(framesB.some((frame) => frame.dataSeq > SEED && seenOnA.has(frame.dataSeq))).toBe(true)

			const before = await readCount(b, 'tier-fromseq')
			await b.getByTestId('toggle-subscribe').click()
			await expect(b.getByTestId('fromseq-fast-hint')).toContainText('fromSeq stream paused')
			const frozen = Math.max(...(await rows(b)).map((entry) => entry.seq))
			await expect.poll(async () => Math.max(...(await rows(a)).map((entry) => entry.seq)), { timeout: 6_000 })
				.toBeGreaterThan(frozen + 1)
			await b.getByTestId('toggle-subscribe').click()
			await expect.poll(() => readCount(b, 'tier-fromseq'), { timeout: 8_000 }).toBeGreaterThan(before)
			await expectGapFilledFrom(b, frozen)
			assertIntegrity(await rows(b))
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
