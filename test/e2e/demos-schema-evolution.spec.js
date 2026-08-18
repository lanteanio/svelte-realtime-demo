import { test, expect } from '@playwright/test'
import { confirmAndClick, waitForWS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const IDS = ['alpha', 'beta', 'gamma']
const LABELS = ['Alpha counter', 'Beta counter', 'Gamma counter']

async function open(page) {
	await page.goto('/demos/schema-evolution')
	await waitForWS(page)
	await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
	await expect(page.getByTestId('v1mig-card')).toHaveCount(3, { timeout: 8_000 })
}

async function expectValues(page, expected) {
	for (const id of IDS) {
		await expect(page.getByTestId(`v2-value-${id}`)).toHaveText(String(expected[id]))
		await expect(page.getByTestId(`v1mig-value-${id}`)).toHaveText(String(expected[id]))
	}
}

async function expectV1Provenance(page, expected) {
	for (const id of IDS) {
		await expect(page.getByTestId(`v1mig-provenance-${id}`)).toHaveText(expected[id] ?? expected)
	}
}

async function reset(page) {
	await confirmAndClick(page.getByTestId('reset'))
	await expectValues(page, { alpha: 0, beta: 0, gamma: 0 })
	await expectV1Provenance(page, 'loader')
}

async function reloadMigrated(page) {
	await page.reload()
	// A reload is a full navigation and can leave the client bundle dead
	// exactly as a goto can, and callers click as soon as this returns. The
	// count below does eventually notice, but it reports the wrong thing: a
	// dead bundle surfaces as "v2-card expected 3, received 0" after the full
	// eight seconds, naming a content selector rather than the asset that
	// failed to load. Gating first turns that into a readiness failure that
	// names the dead chunk.
	await waitForWS(page)
	await expect(page.getByTestId('v2-card')).toHaveCount(3, { timeout: 8_000 })
	await expectV1Provenance(page, 'migrate[1]')
}

test.describe('/demos/schema-evolution', () => {
	// The panels are an equal-height grid and daisyUI gives card-body's <p>
	// flex-grow, so the descriptions stretched and bottom-anchored the rows.
	// At the tablet rung the right panel wraps its labels onto two lines, so
	// the left panel opened a blank band and the same counter sat at different
	// heights in the two panels - which breaks the row-to-row comparison a
	// side-by-side layout exists to offer. Asserted at the rung the finding
	// names, since at wider widths neither panel wraps and it passes anyway.
	test('the same counter sits at the same height in both panels, at the rung where labels wrap', async ({ page }) => {
		await page.setViewportSize({ width: 768, height: 900 })
		await open(page)
		for (const id of IDS) {
			const tops = await Promise.all([
				page.getByTestId(`v2-value-${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top)),
				page.getByTestId(`v1mig-value-${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top))
			])
			expect(Math.abs(tops[0] - tops[1]), `${id} must share a baseline across the two panels`).toBeLessThanOrEqual(2)
		}
	})

	// A swallowed failure left an empty code box and a version chip still
	// showing the CLIENT's own default as though the server had confirmed it.
	// Forced here by dropping the state RPC's reply on the wire, which is the
	// only way to reach the branch: the call succeeds on every healthy run.
	test('a state call that never answers withholds the chip and says so, instead of showing an empty box', async ({ page }) => {
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer()
			// Dropped on the way OUT, not on the way back: the reply frame
			// carries a correlation id rather than the handler name, so
			// filtering the response would match nothing and the call would
			// quietly succeed - a test that passes for the wrong reason.
			// Everything else flows, so the page still connects and both
			// projections still hydrate; this isolates the one call.
			ws.onMessage((m) => {
				if (typeof m === 'string' && m.includes('myCounterState')) return
				server.send(m)
			})
			server.onMessage((m) => ws.send(m))
		})
		await open(page)
		await expect(page.getByTestId('state-pending')).toBeVisible()
		await expect(page.getByTestId('migrate-source')).toHaveCount(0)
		// The chip asserted a server fact from a client default. Absent is the
		// honest reading while nobody has answered.
		await expect(page.getByTestId('server-version')).toHaveCount(0)
	})

	// Both panels render identical rows, so the only visible difference was a
	// badge: the visitor was asked to verify a migration ran without seeing
	// what it transformed. The sample is produced by the REAL v1ToV2 on the
	// server, so this asserts the transformation rather than a caption about
	// it - the fields the migration synthesizes must be absent before and
	// present after.
	test('the page shows what the migration actually does to a row', async ({ page }) => {
		await open(page)
		const before = JSON.parse(await page.getByTestId('migrate-sample-before').innerText())
		const after = JSON.parse(await page.getByTestId('migrate-sample-after').innerText())

		for (const field of ['label', 'color', 'provenance', 'modifiedAt']) {
			expect(before, `v1 rows have no ${field}`).not.toHaveProperty(field)
			expect(after, `migrate[1] synthesizes ${field}`).toHaveProperty(field)
		}
		// Carried through, not invented: the migration must not rewrite what v1
		// already had.
		expect(after.id).toBe(before.id)
		expect(after.value).toBe(before.value)
		expect(after.provenance).toBe('migrate[1]')
	})

	// At 320 the first screen held the h1 and seven lines of prose and nothing
	// else - no panel, no counter, no button - so the demo failed the glance
	// test on the harshest rung. Asserted as the thing the finding is about:
	// live rows must crest the fold, not merely exist further down.
	test('a phone sees live rows on the first screen, and can still read the whole intro', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await open(page)

		const firstRow = await page.getByTestId('v2-value-alpha').evaluate((el) => el.getBoundingClientRect().top)
		expect(firstRow, 'a live counter must be above the fold').toBeLessThan(568)

		// And nothing is lost: the clamp is a fold, not a deletion.
		await expect(page.getByTestId('intro')).toHaveAttribute('data-clamped', 'true')
		await page.getByTestId('intro-toggle').click()
		await expect(page.getByTestId('intro')).toHaveAttribute('data-clamped', 'false')
		await expect(page.getByTestId('intro')).toContainText('merging into the migrated base')
	})

	test('renders both exact projections, all controls, server version, and migration source', async ({ page }) => {
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Schema evolution: subscribe-time migrate hooks')
		expect(await page.getByTestId('v2-label').allTextContents()).toEqual(LABELS)
		expect(await page.getByTestId('v1mig-label').allTextContents()).toEqual(LABELS)
		for (let i = 0; i < 3; i++) await expect(page.getByTestId('v2-provenance').nth(i)).toHaveText('loader')
		await expectV1Provenance(page, 'migrate[1]')
		for (const id of IDS) await expect(page.getByTestId(`bump-${id}`)).toHaveText(`Increment ${id}`)
		await expect(page.getByTestId('reset')).toHaveText('Reset all')
		await expect(page.getByText('server version: 2', { exact: true })).toBeVisible()
		const source = page.getByTestId('migrate-source')
		await expect(source).toContainText('version: 2')
		await expect(source).toContainText('migrate: { 1: v1ToV2 }')
		await expect(source).toContainText("merge: 'crud'")
		await expect(source).toContainText('key: id')
	})

	test('Reset publishes raw v2 loader rows; reload reruns migrate[1] only for the stale projection', async ({ page }) => {
		await open(page)
		await page.getByTestId('bump-alpha').click()
		await expect(page.getByTestId('v2-value-alpha')).not.toHaveText('0')
		await reset(page)
		await reloadMigrated(page)
		await expectValues(page, { alpha: 0, beta: 0, gamma: 0 })
		for (let i = 0; i < 3; i++) await expect(page.getByTestId('v2-provenance').nth(i)).toHaveText('loader')
	})

	test('every increment updates only its key and flips that stale-client row to loader', async ({ page }) => {
		await open(page)
		await reset(page)
		await reloadMigrated(page)
		const expected = { alpha: 0, beta: 0, gamma: 0 }
		const provenance = { alpha: 'migrate[1]', beta: 'migrate[1]', gamma: 'migrate[1]' }
		for (const id of IDS) {
			await page.getByTestId(`bump-${id}`).click()
			expected[id] = 1
			provenance[id] = 'loader'
			await expectValues(page, expected)
			await expectV1Provenance(page, provenance)
		}
	})

	test('three serialized beta clicks converge on value 3 in both projections', async ({ page }) => {
		await open(page)
		await reset(page)
		await reloadMigrated(page)
		for (let value = 1; value <= 3; value++) {
			await page.getByTestId('bump-beta').click()
			await expect(page.getByTestId('v2-value-beta')).toHaveText(String(value))
			await expect(page.getByTestId('v1mig-value-beta')).toHaveText(String(value))
		}
		await expect(page.getByTestId('v1mig-provenance-beta')).toHaveText('loader')
	})

	test('two tabs increment the same Redis field concurrently without losing a count, then share Reset', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([open(a), open(b)])
			await reset(a)
			await Promise.all([reloadMigrated(a), reloadMigrated(b)])
			await Promise.all([
				a.getByTestId('bump-gamma').click(),
				b.getByTestId('bump-gamma').click()
			])
			for (const page of [a, b]) {
				await expect(page.getByTestId('v2-value-gamma')).toHaveText('2')
				await expect(page.getByTestId('v1mig-value-gamma')).toHaveText('2')
				await expect(page.getByTestId('v1mig-provenance-gamma')).toHaveText('loader')
			}
			await reset(b)
			await expectValues(a, { alpha: 0, beta: 0, gamma: 0 })
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
	// The state RPC feeds the teaching half of this page: the registration
	// snippet and the server-version chip come from the same call. When it
	// failed, the page said nothing - an empty code box where the snippet
	// should be, and a chip still reading "server version: 2", which is the
	// CLIENT default and not something the server ever confirmed. A visitor
	// could not tell a broken page from a page whose server disagrees with it.
	//
	// Reached by closing the socket, which is the only way to make the RPC
	// actually reject; asserting the error markup exists in the DOM proves
	// nothing about whether anything can reach it.
	test('a failed state fetch is explained, and withholds what it could not confirm', async ({ page }) => {
		test.setTimeout(60_000)
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => ws.close())
		await page.goto('/demos/schema-evolution')

		const error = page.getByTestId('state-error')
		await expect(error).toBeVisible({ timeout: 20_000 })
		await expect(error).toContainText('Could not load the stream registration')
		// The cause is named, not swallowed into a generic apology.
		await expect(error).toContainText('DISCONNECTED')

		// Both halves of that call are withheld rather than guessed at. The empty
		// <pre> was the original complaint, and the chip is the subtler one: a
		// client default rendered as a server fact.
		await expect(page.getByTestId('migrate-source')).toHaveCount(0)
		await expect(
			page.getByTestId('server-version'),
			'the version chip must not assert a value the server never confirmed'
		).toHaveCount(0)
	})

})
