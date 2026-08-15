import { test, expect } from '@playwright/test'
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
			const fromSeqBefore = await readCount(a, 'tier-fromseq')
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
			expect(await readCount(a, 'tier-fromseq')).toBe(fromSeqBefore)
			assertIntegrity(await rows(a))
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
