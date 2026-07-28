import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

// Cross-replica proof for /demos/collab-editor. The two browser contexts are
// pinned to different app instances sharing Redis. This exercises the two
// claims that a single-tab test cannot establish: live.doc edits converge
// across replicas, and multiplayer selection state follows those edits with
// deliberately different offset and CRDT semantics.

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/collab-editor`)
	await waitForWS(page)
	await expect(page.getByTestId('collab-doc-synced')).toHaveText('synced', { timeout: 15_000 })
}

async function selectRange(locator, start, end) {
	await locator.evaluate((element, range) => {
		element.focus()
		element.setSelectionRange(range.start, range.end)
		element.dispatchEvent(new Event('select', { bubbles: true }))
	}, { start, end })
}

test.describe('cluster: /demos/collab-editor cross-replica', () => {
	test.skip(!process.env.INSTANCE_B, 'requires INSTANCE_B (two instances on shared Redis/Postgres)')

	test('the shared document and character counts converge in both directions', async ({ browser }) => {
		test.setTimeout(90_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// The document persists globally, so establish a known baseline before
			// making claims about cross-replica values and character counts.
			await confirmAndClick(a.getByTestId('collab-clear'))
			for (const page of [a, b]) {
				await expect(page.getByTestId('collab-offset-textarea')).toHaveValue('', { timeout: 10_000 })
				await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue('', { timeout: 10_000 })
				await expect(page.getByTestId('collab-doc-length')).toHaveText('0 chars', { timeout: 10_000 })
			}

			const initial = 'alpha TARGET omega'
			await a.getByTestId('collab-offset-textarea').fill(initial)
			for (const page of [a, b]) {
				await expect(page.getByTestId('collab-offset-textarea')).toHaveValue(initial, { timeout: 10_000 })
				await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(initial, { timeout: 10_000 })
				await expect(page.getByTestId('collab-doc-length')).toHaveText(`${initial.length} chars`, { timeout: 10_000 })
			}

			// Reverse direction proves B is not merely rendering A's local echo.
			const prefixed = `PREFIX ${initial}`
			await b.getByTestId('collab-offset-textarea').fill(prefixed)
			for (const page of [a, b]) {
				await expect(page.getByTestId('collab-offset-textarea')).toHaveValue(prefixed, { timeout: 10_000 })
				await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(prefixed, { timeout: 10_000 })
				await expect(page.getByTestId('collab-doc-length')).toHaveText(`${prefixed.length} chars`, { timeout: 10_000 })
			}
			await expect(a.getByTestId('collab-error')).toHaveCount(0)
			await expect(b.getByTestId('collab-error')).toHaveCount(0)
		} finally {
			await confirmAndClick(a.getByTestId('collab-clear'), { timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('remote offset and CRDT selections converge with different edit semantics', async ({ browser }) => {
		test.setTimeout(90_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openAt(a, INSTANCE_A)
			await openAt(b, INSTANCE_B)

			// Presence in both fixed rooms is the readiness gate for remote
			// selection delivery; document sync alone does not prove it.
			await expect(a.getByTestId('collab-offset-panel')).toContainText('1 other person', { timeout: 15_000 })
			await expect(a.getByTestId('collab-crdt-panel')).toContainText('1 other person', { timeout: 15_000 })
			await expect(b.getByTestId('collab-offset-panel')).toContainText('1 other person', { timeout: 15_000 })
			await expect(b.getByTestId('collab-crdt-panel')).toContainText('1 other person', { timeout: 15_000 })

			await confirmAndClick(a.getByTestId('collab-clear'))
			await expect(b.getByTestId('collab-offset-textarea')).toHaveValue('', { timeout: 10_000 })
			const initial = 'alpha TARGET omega'
			await a.getByTestId('collab-offset-textarea').fill(initial)
			await expect(b.getByTestId('collab-crdt-textarea')).toHaveValue(initial, { timeout: 10_000 })

			// Each selection mode is its own multiplayer room, so A must publish
			// the same [6, 12) range from both textareas. B is the remote viewer.
			await selectRange(a.getByTestId('collab-offset-textarea'), 6, 12)
			await selectRange(a.getByTestId('collab-crdt-textarea'), 6, 12)
			const offsetRow = b.getByTestId('collab-offset-selection-row')
			const crdtRow = b.getByTestId('collab-crdt-selection-row')
			await expect(offsetRow).toContainText('[6, 12)', { timeout: 15_000 })
			await expect(offsetRow).toContainText('"TARGET"')
			await expect(crdtRow).toContainText('[6, 12)', { timeout: 15_000 })
			await expect(crdtRow).toContainText('"TARGET"')

			// B inserts seven characters before the selected word. Raw offsets
			// remain frozen on [6, 12) and now select " alpha"; CRDT anchors move
			// to [13, 19) and stay glued to TARGET.
			const prefixed = `PREFIX ${initial}`
			await b.getByTestId('collab-offset-textarea').fill(prefixed)
			for (const page of [a, b]) {
				await expect(page.getByTestId('collab-offset-textarea')).toHaveValue(prefixed, { timeout: 10_000 })
				await expect(page.getByTestId('collab-crdt-textarea')).toHaveValue(prefixed, { timeout: 10_000 })
				await expect(page.getByTestId('collab-doc-length')).toHaveText(`${prefixed.length} chars`, { timeout: 10_000 })
			}
			await expect(offsetRow).toContainText('[6, 12)', { timeout: 15_000 })
			await expect(offsetRow).toContainText('" alpha"')
			await expect(crdtRow).toContainText('[13, 19)', { timeout: 15_000 })
			await expect(crdtRow).toContainText('"TARGET"')
			await expect(a.getByTestId('collab-error')).toHaveCount(0)
			await expect(b.getByTestId('collab-error')).toHaveCount(0)
		} finally {
			await confirmAndClick(a.getByTestId('collab-clear'), { timeout: 2_000 }).catch(() => {})
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
