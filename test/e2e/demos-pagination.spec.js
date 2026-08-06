import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/pagination - a 200-entry log feed
// served in cursor-based pages of 25 (loader returns { data, hasMore, cursor },
// merge:'crud' keyed by id) plus an append form publishing 'created' on the
// same topic. Drives every interactive element (Load more, severity select,
// message input, Append) and asserts REAL outcomes: exact seq contiguity per
// page (proving the cursor advanced to the NEXT chronological slice, not a
// repeat), the in-flight loading state (via delayed WS frames), live 'created'
// events composing with a partially-paged list, cross-tab fan-out, a crash
// guard for the live-event + paginated-catch-up collision, exhaustion, and
// the immutable page-1 invariant. Cross-replica behaviour lives in the
// .cluster.spec.js sibling.
//
// The backing store is a single GLOBAL Redis LIST shared by every tab, seeded
// once with seqs 1..200 oldest-first. Appends land at the END of the list, so
// page 1 (offset 0..24) is ALWAYS exactly seqs 1..25 - that makes first-page
// assertions exact while totals stay delta-based (appends from earlier tests
// in the serial tier persist). Tests run serially (workers=1).

const RUN = `e2e-${Date.now()}`
const PAGE_SIZE = 25
const SEEDED_TOTAL = 200

async function open(page) {
	await page.goto('/demos/pagination')
	await waitForWS(page)
	// Real hydration gate: the initial paginated frame always carries exactly
	// PAGE_SIZE rows (the list never shrinks below the 200-entry seed).
	await expect(page.getByTestId('entry-row')).toHaveCount(PAGE_SIZE, { timeout: 15_000 })
}

async function seqsOf(page) {
	return page
		.locator('[data-testid="entry-row"]')
		.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))))
}

function expectContiguousFromOne(seqs, n) {
	expect(seqs.length).toBe(n)
	for (let i = 0; i < n; i++) {
		expect(seqs[i]).toBe(i + 1)
	}
}

test.describe('/demos/pagination', () => {
	test('hydrates with exactly page 1: seqs 1..25 oldest-first, hasMore true', async ({ page }) => {
		test.setTimeout(25_000)
		await open(page)

		// The first page is the oldest 25 seeded entries, in chronological
		// order - exact, not just a count.
		expectContiguousFromOne(await seqsOf(page), PAGE_SIZE)
		await expect(page.getByTestId('entries-count')).toHaveText(String(PAGE_SIZE))
		// Discriminating BECAUSE the page no longer initialises hasMore to
		// true: until a frame lands the caption reads "waiting for the first
		// page", so reading "true" here can only have come off the wire.
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: true')
		await expect(page.getByTestId('cursor-state')).toContainText('{ offset }')
		await expect(page.getByTestId('load-more')).toBeEnabled()
		await expect(page.getByTestId('load-more')).toHaveText(`Load more (next ${PAGE_SIZE})`)
		// Fixed 80px time column: two-digit h23 keeps every locale inside it.
		await expect(page.getByTestId('entry-time').first()).toHaveText(/^\d{2}:\d{2}:\d{2}$/)
	})

	test('the Load more target does not flee down the page as rows arrive', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)

		const button = page.getByTestId('load-more')
		// Measured against the DOCUMENT, not the viewport: a click can scroll
		// the page, and a viewport-relative box reports that as the control
		// moving when the layout never changed. What this finding is about is
		// the button being pushed down the page by rows inserted above it.
		const docTop = () => button.evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
		const before = await docTop()

		await button.click()
		await expect(page.getByTestId('entry-row')).toHaveCount(2 * PAGE_SIZE, { timeout: 8_000 })

		// 25 more rows merged ABOVE this control. It used to be displaced about
		// a full viewport downward per load; the rows grow inside their own
		// scroll region now, so the target the visitor is about to press again
		// is still where they left it.
		const after = await docTop()
		expect(
			Math.abs(after - before),
			`Load more moved ${Math.round(after - before)}px down the document after one load`
		).toBeLessThanOrEqual(2)

		// ...and it stayed put because the list scrolls, not because the load
		// silently failed to add anything.
		const scrolls = await page.getByTestId('entries-list')
			.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
		expect(scrolls, 'the entries list must be its own scroll region').toBe(true)
	})

	test('Load more reads as the primary action and meets the 44px floor', async ({ browser }) => {
		test.setTimeout(30_000)
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			// It was a borderless btn-sm, visually indistinguishable from the
			// caption beside it and under the touch minimum.
			await expect(page.getByTestId('load-more')).toHaveClass(/btn-primary/)
			await expectTouchTarget(page.getByTestId('load-more'))
		} finally {
			await context.close()
		}
	})

	test('Load more advances the cursor to the NEXT chronological slice', async ({ page }) => {
		test.setTimeout(25_000)
		await open(page)

		await page.getByTestId('load-more').click()
		await expect(page.getByTestId('entry-row')).toHaveCount(2 * PAGE_SIZE, { timeout: 8_000 })

		// Seqs must now be exactly 1..50: the client upserts loadMore rows by
		// key (realtime next.90), so a loader that re-served page 1 would
		// leave the count stuck at PAGE_SIZE and a wrong slice would break
		// contiguity. This proves the cursor was stamped and honored, not
		// merely that more rows appeared.
		expectContiguousFromOne(await seqsOf(page), 2 * PAGE_SIZE)
		await expect(page.getByTestId('entries-count')).toHaveText(String(2 * PAGE_SIZE))
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: true')
	})

	test('Load more shows a real in-flight state (button disabled, Loading label)', async ({ page }) => {
		test.setTimeout(45_000)
		// Delay every server->client frame. The pending UI (disabled button with
		// a 'Loading...' label) must appear the instant Load more is clicked and
		// persist until the delayed page-2 frame lands - if the button state were
		// only flipped by data arrival this assertion window would catch it.
		const SERVER_DELAY = 1_500
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			ws.onMessage((m) => server.send(m))
			server.onMessage((m) => { setTimeout(() => ws.send(m), SERVER_DELAY) })
		})
		await open(page)

		await page.getByTestId('load-more').click()
		// Both pending properties read atomically, well inside the delay
		// window - the server reply cannot have arrived yet, so this is the
		// client-side pending state. (A two-step assertion could race the
		// delayed frame between the checks.)
		await expect
			.poll(
				() => page.getByTestId('load-more').evaluate((el) => ({ disabled: el.disabled, text: el.textContent.trim() })),
				{ timeout: SERVER_DELAY - 700 }
			)
			.toEqual({ disabled: true, text: 'Loading...' })

		// Once the delayed frame lands: page 2 merged, pending state cleared.
		await expect(page.getByTestId('entry-row')).toHaveCount(2 * PAGE_SIZE, { timeout: 3 * SERVER_DELAY })
		await expect(page.getByTestId('load-more')).toBeEnabled()
		await expect(page.getByTestId('load-more')).toHaveText(`Load more (next ${PAGE_SIZE})`)
	})

	test('Append drives the form and the new entry lands at the BOTTOM with a seq jump', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		const before = (await seqsOf(page)).length

		const tag = `append-${RUN}`
		await page.getByTestId('append-severity').selectOption('error')
		await page.getByTestId('append-message').fill(tag)
		await page.getByTestId('append-submit').click()

		// The 'created' event merges into the PARTIALLY-paged list: only page 1
		// (seqs 1..25) is loaded, yet the new entry (seq > 200) appears at the
		// bottom without loading the pages in between - the visible seq jump is
		// the proof that live events compose with pagination.
		await expect(page.getByTestId('entry-row')).toHaveCount(before + 1, { timeout: 8_000 })
		const lastRow = page.getByTestId('entry-row').last()
		await expect(lastRow.getByTestId('entry-message')).toHaveText(tag)
		await expect(lastRow.getByTestId('entry-severity')).toHaveText('error')
		await expect(page.getByTestId('append-confirmation')).toContainText(tag)
		await expect(lastRow).toBeInViewport()
		await expect(lastRow).toHaveClass(/append-highlight/)
		const seqs = await seqsOf(page)
		expect(seqs[seqs.length - 1]).toBeGreaterThan(SEEDED_TOTAL)
		expect(seqs[seqs.length - 2]).toBe(PAGE_SIZE)
	})

	// Pins the CLIENT-side normalization ('manual entry'); the server has its
	// own, different fallback, so any regression path renders something else.
	test('a blank message is normalized to the default entry text', async ({ page }) => {
		test.setTimeout(30_000)
		await open(page)
		const before = (await seqsOf(page)).length

		await page.getByTestId('append-message').fill('   ')
		await page.getByTestId('append-submit').click()

		await expect(page.getByTestId('entry-row')).toHaveCount(before + 1, { timeout: 8_000 })
		const lastRow = page.getByTestId('entry-row').last()
		await expect(lastRow.getByTestId('entry-message')).toHaveText('manual entry')
		// Severity select was left at its default.
		await expect(lastRow.getByTestId('entry-severity')).toHaveText('info')
	})

	test('an append in one tab lands live at the bottom of another tab', async ({ browser }) => {
		test.setTimeout(40_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const beforeB = (await seqsOf(b)).length

			const tag = `xtab-${RUN}`
			await a.getByTestId('append-message').fill(tag)
			await a.getByTestId('append-submit').click()

			// Tab B took no action; the specific tagged row must arrive at ITS
			// bottom via the live broadcast (asserting the tag, not just a count,
			// so an unrelated event cannot satisfy this).
			await expect(b.getByTestId('entry-row')).toHaveCount(beforeB + 1, { timeout: 8_000 })
			const lastB = b.getByTestId('entry-row').last()
			await expect(lastB.getByTestId('entry-message')).toHaveText(tag)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	// Regression guard for the upstream loadMore keyed upsert (svelte-realtime
	// next.90): an entry received LIVE while only page 1 is loaded is
	// re-served by the final loadMore slice, and the page row must dedupe
	// against the stream's key index instead of concatenating into a
	// duplicated key that makes Svelte's keyed each throw each_key_duplicate.
	// The throw happens BEFORE the DOM commit, so locator assertions alone
	// would pass against the stale pre-crash render; only the pageerror
	// channel can observe it.
	test('a live-received entry survives paging through the full history (crash guard)', async ({ page }) => {
		test.setTimeout(90_000)
		const pageErrors = []
		page.on('pageerror', (err) => pageErrors.push(String(err)))

		await open(page)

		// Receive the new entry live first (only page 1 is loaded; the entry
		// lands at the bottom via the 'created' broadcast)...
		const tag = `livedupe-${RUN}`
		await page.getByTestId('append-message').fill(tag)
		await page.getByTestId('append-submit').click()
		await expect(page.getByTestId('entry-row').last().getByTestId('entry-message')).toHaveText(tag, { timeout: 8_000 })

		// ...then page through the WHOLE history, whose final slice re-serves
		// that same entry - exactly the duplicate-id collision the keyed
		// render must survive. (This appends one entry; totals elsewhere are
		// delta-based, so no other test needs adjusting.)
		for (let i = 0; i < 14; i++) {
			const stateText = await page.getByTestId('has-more-state').textContent()
			if (stateText?.includes('hasMore: false')) break
			const before = await page.getByTestId('entry-row').count()
			await page.getByTestId('load-more').click()
			await expect
				.poll(async () => {
					const grown = (await page.getByTestId('entry-row').count()) > before
					const done = (await page.getByTestId('has-more-state').textContent())?.includes('hasMore: false')
					return grown || done
				}, { timeout: 8_000 })
				.toBe(true)
		}
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: false', { timeout: 5_000 })

		// The crash guard first: DOM assertions cannot see a pre-commit
		// throw, this can.
		expect(
			pageErrors,
			`client-side crash while paginating past a live-received entry: ${pageErrors.join('; ')}`
		).toEqual([])

		// Once the render survives, the live-received entry must appear
		// exactly once and the list must hold no duplicate seqs at all.
		const tagged = page.locator('[data-testid="entry-message"]', { hasText: tag })
		await expect(tagged).toHaveCount(1)
		const seqs = await seqsOf(page)
		expect(new Set(seqs).size).toBe(seqs.length)
	})

	test('exhausting pagination: contiguous history, hasMore false, button disabled', async ({ page }) => {
		test.setTimeout(60_000)
		await open(page)

		// 200 seeded entries = 8 pages; appends from earlier tests in this
		// serial tier add a short tail page. Cap the loop well above that.
		for (let i = 0; i < 14; i++) {
			const stateText = await page.getByTestId('has-more-state').textContent()
			if (stateText?.includes('hasMore: false')) break
			const before = await page.getByTestId('entry-row').count()
			await page.getByTestId('load-more').click()
			// Wait for the click to actually grow the list (or flip hasMore)
			// instead of a blind sleep.
			await expect
				.poll(async () => {
					const grown = (await page.getByTestId('entry-row').count()) > before
					const done = (await page.getByTestId('has-more-state').textContent())?.includes('hasMore: false')
					return grown || done
				}, { timeout: 8_000 })
				.toBe(true)
		}

		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: false', { timeout: 5_000 })
		// The loader stops returning a cursor once the feed is exhausted, and
		// the readout says so - approached from the paging side, so this waits
		// for the real transition rather than reading a never-paged page.
		await expect(page.getByTestId('cursor-state')).toContainText('next cursor: null')
		await expect(page.getByTestId('load-more')).toBeDisabled()
		await expect(page.getByTestId('load-more')).toHaveText('No more entries')

		const seqs = await seqsOf(page)
		// The full seeded history is present and exact...
		expect(seqs.length).toBeGreaterThanOrEqual(SEEDED_TOTAL)
		expectContiguousFromOne(seqs.slice(0, SEEDED_TOTAL), SEEDED_TOTAL)
		// ...and the appended tail keeps strictly increasing seqs with no
		// duplicates (the crud merge by id never double-inserts).
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
		}
	})

	test('page 1 is immutable: a fresh load after appends still serves seqs 1..25', async ({ page }) => {
		test.setTimeout(25_000)
		// Earlier tests appended several entries. They rpush onto the END of the
		// list, so the first page - the oldest slice - must be untouched. A
		// prepend-shaped store would shift the window and break this.
		await open(page)
		expectContiguousFromOne(await seqsOf(page), PAGE_SIZE)
		await expect(page.getByTestId('has-more-state')).toContainText('hasMore: true')
	})
})
