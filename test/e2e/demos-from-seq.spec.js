import { test, expect } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

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
		expect(entry.message).toContain(`#${entry.seq}`)
		expect(entry.tier).toMatch(/^(live|rehydrate|fromSeq)$/)
	}
}

async function open(page) {
	await page.goto('/demos/from-seq')
	await expect.poll(() => page.getByTestId('event-row').count(), { timeout: 8_000 }).toBeGreaterThanOrEqual(2)
}

test.describe('/demos/from-seq', () => {
	test('renders the complete subscribed state with conserved tier counters and valid event rows', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reconnect: three-tier gap fill via delta.fromSeq')
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
		const beforeFromSeq = await readCount(page, 'tier-fromseq')

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
		expect(await readCount(page, 'tier-fromseq')).toBe(beforeFromSeq)
		await expect.poll(() => page.getByTestId('event-row').count()).toBeGreaterThan(beforeSeqs.length)
		await expectIntegrity(page)
	})

	test('demo-scoped fast path reaches the real fromSeq tier after a two-second pause', async ({ page }) => {
		await open(page)
		const before = await readCount(page, 'tier-fromseq')
		await page.getByTestId('fromseq-fast-path').click()
		await expect(page.getByTestId('fromseq-fast-path')).toHaveAttribute('aria-pressed', 'true')
		await expect(page.getByTestId('fromseq-fast-hint')).toContainText('Fast path ready', { timeout: 5_000 })
		await expect(page.getByTestId('toggle-subscribe')).toBeEnabled()

		await page.getByTestId('toggle-subscribe').click()
		await expect(page.getByTestId('fromseq-fast-hint')).toContainText('Fast path paused')
		await page.waitForTimeout(2_200)
		await page.getByTestId('toggle-subscribe').click()
		await expect.poll(() => readCount(page, 'tier-fromseq'), { timeout: 8_000 }).toBeGreaterThan(before)
		await expect(page.locator('[data-testid^="event-tier-"]').filter({ hasText: 'fromSeq' }).first()).toBeVisible()
		await expectIntegrity(page)
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
