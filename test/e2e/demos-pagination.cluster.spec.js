import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

// Cross-replica coverage for /demos/pagination: two tabs forced onto DIFFERENT
// SO_REUSEPORT replicas (instance A vs instance B) against shared Redis +
// Postgres. This tier proves the properties the single-instance suite cannot
// see:
//   1. Both replicas serve the IDENTICAL page 1 - ids/seqs are deterministic
//      so this alone is gross seed sanity; the rendered TIMESTAMPS carry the
//      seeding clock, so comparing them additionally catches a NON-shared
//      store (each instance seeding its own Redis stamps a different clock).
//   2. An append RPC handled on replica A fans out over the cross-replica
//      bus and lands live at the bottom of a subscriber on replica B.
//   3. A live 'created' event and the paginated catch-up of the SAME entry
//      must coexist: after B pages through the whole history, the entry
//      appended on A appears exactly once, with NO client-side crash. (The
//      client concatenates loadMore slices without id-dedupe, so the final
//      slice re-serving a live-received entry is exactly the collision this
//      guards.)
//
// Runs in the cluster tier (playwright project 'cluster', started with two
// instances + INSTANCE_B). Skipped elsewhere.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

const RUN = `cluster-${Date.now()}`
const PAGE_SIZE = 25

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/pagination`)
	await waitForWS(page)
	await expect(page.getByTestId('entry-row')).toHaveCount(PAGE_SIZE, { timeout: 15_000 })
}

async function seqsOf(page) {
	return page
		.locator('[data-testid="entry-row"]')
		.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))))
}

test.describe('cluster: /demos/pagination cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('both replicas serve the identical page 1 from the shared seeded store', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			const seqsA = await seqsOf(a)
			const seqsB = await seqsOf(b)
			// Seq parity alone is weak (ids/seqs are deterministic, so even two
			// independent stores would agree); it pins gross seed sanity.
			expect(seqsA).toEqual(seqsB)
			expect(seqsA.length).toBe(PAGE_SIZE)
			for (let i = 0; i < PAGE_SIZE; i++) {
				expect(seqsA[i]).toBe(i + 1)
			}
			// The rendered times derive from the seeding clock, so a NON-shared
			// store (each instance seeding its own Redis) stamps two different
			// clocks and diverges here even though the seqs agree. (A double
			// seed on the SHARED store overwrites the first atomically and
			// stays invisible to this read - not covered here.)
			const timesA = await a.locator('[data-testid="entry-time"]').allTextContents()
			const timesB = await b.locator('[data-testid="entry-time"]').allTextContents()
			expect(timesA).toEqual(timesB)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('an append on replica A lands live at the bottom on replica B', async ({ browser }) => {
		test.setTimeout(60_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)
			const beforeB = (await seqsOf(b)).length

			const tag = `xreplica-${RUN}`
			await a.getByTestId('append-severity').selectOption('warn')
			await a.getByTestId('append-message').fill(tag)
			await a.getByTestId('append-submit').click()

			// B never touched the form; the tagged row can only arrive via the
			// cross-replica bus relay.
			await expect(b.getByTestId('entry-row')).toHaveCount(beforeB + 1, { timeout: 10_000 })
			const lastB = b.getByTestId('entry-row').last()
			await expect(lastB.getByTestId('entry-message')).toHaveText(tag)
			await expect(lastB.getByTestId('entry-severity')).toHaveText('warn')
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('live event + paginated catch-up of the same entry coexist on replica B without a crash', async ({ browser }) => {
		// KNOWN-BROKEN upstream: the svelte-realtime client applies loadMore
		// slices by blind concat with no id-dedupe, so the final slice
		// re-serving the live-received entry duplicates its key and Svelte's
		// keyed each throws each_key_duplicate. This guard is EXPECTED to fail
		// until the upstream fix lands; it then reports 'passed unexpectedly' -
		// remove this test.fail() at that point.
		test.fail(true, 'upstream svelte-realtime: loadMore applies slices by blind concat with no id-dedupe, so paginating past a live-received entry throws each_key_duplicate')
		test.setTimeout(90_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			// A page-level JS crash (e.g. Svelte's duplicate-key throw on a keyed
			// each) aborts the render BEFORE the DOM commit, so every locator
			// assertion below could pass against the stale pre-crash DOM. The
			// pageerror channel is the only observer such a crash cannot hide
			// from - collect it from the start.
			const pageErrors = []
			b.on('pageerror', (err) => pageErrors.push(String(err)))

			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// B receives the appended entry live first (only page 1 loaded)...
			const tag = `dedupe-${RUN}`
			await a.getByTestId('append-message').fill(tag)
			await a.getByTestId('append-submit').click()
			await expect(b.getByTestId('entry-row').last().getByTestId('entry-message')).toHaveText(tag, { timeout: 10_000 })

			// ...then B pages through the WHOLE history, whose final slice
			// re-serves that same entry. The client concatenates loadMore slices
			// without id-dedupe, so this is exactly the duplicate-id collision
			// the keyed render must survive.
			for (let i = 0; i < 14; i++) {
				const stateText = await b.getByTestId('has-more-state').textContent()
				if (stateText?.includes('hasMore: false')) break
				const before = await b.getByTestId('entry-row').count()
				await b.getByTestId('load-more').click()
				await expect
					.poll(async () => {
						const grown = (await b.getByTestId('entry-row').count()) > before
						const done = (await b.getByTestId('has-more-state').textContent())?.includes('hasMore: false')
						return grown || done
					}, { timeout: 10_000 })
					.toBe(true)
			}
			await expect(b.getByTestId('has-more-state')).toContainText('hasMore: false', { timeout: 5_000 })

			// The crash guard first: DOM assertions cannot see a pre-commit
			// throw, this can.
			expect(
				pageErrors,
				`client-side crash while paginating past a live-received entry: ${pageErrors.join('; ')}`
			).toEqual([])

			const tagged = b.locator('[data-testid="entry-message"]', { hasText: tag })
			await expect(tagged).toHaveCount(1)

			// And the full list has no duplicate seqs at all.
			const seqs = await seqsOf(b)
			expect(new Set(seqs).size).toBe(seqs.length)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
