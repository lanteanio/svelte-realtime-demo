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
		return { seq, message }
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
	expect(new Set(entries.map((entry) => entry.seq)).size).toBe(entries.length)
	for (let i = 1; i < entries.length; i++) expect(entries[i - 1].seq).toBeGreaterThan(entries[i].seq)
	for (const entry of entries) expect(entry.message).toContain(`#${entry.seq}`)
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
			const bySeqB = new Map(rowsB.map((entry) => [entry.seq, entry.message]))
			const overlap = rowsA.filter((entry) => bySeqB.has(entry.seq))
			expect(overlap.length).toBeGreaterThan(0)
			for (const entry of overlap) expect(bySeqB.get(entry.seq)).toBe(entry.message)
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
