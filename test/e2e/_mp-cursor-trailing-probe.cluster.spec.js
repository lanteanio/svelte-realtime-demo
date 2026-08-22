// Why does a peer's cursor settle SHORT of where it was last moved, but only
// in the test that types and submits a headline first?
//
// Cursors alone relay exactly across replicas (measured: four moves and a
// jump, every one landing on the asked-for value). So the fault is not the
// relay. This replicates the preamble the failing test runs first - including
// the submit CLICK, which moves the real mouse - and then reports every cursor
// element B holds, with its name and its position, rather than only the one an
// assertion happens to select.

import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { moveCursor, openMultiplayer, waitForPeers } from './multiplayer-helpers.js'

const strip = (url) => (url.endsWith('/') ? url.slice(0, -1) : url)
const INSTANCE_A = strip(assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href)
const INSTANCE_B = strip(assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href)

test.skip(!process.env.INSTANCE_B, 'this probe needs two explicit replica targets')

async function cursorsOn(page) {
	return page.getByTestId('mp-cursor').evaluateAll((nodes) =>
		nodes.map((n) => ({ label: n.textContent.trim(), style: n.getAttribute('style') }))
	)
}

test('a peer cursor after a headline submit', async ({ browser }) => {
	test.setTimeout(120_000)
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	try {
		await Promise.all([
			openMultiplayer(a, `${INSTANCE_A}/demos/multiplayer`),
			openMultiplayer(b, `${INSTANCE_B}/demos/multiplayer`)
		])
		const { nameA, nameB } = await waitForPeers(a, b)
		console.log(`A is "${nameA}", B is "${nameB}"`)

		const inputA = a.getByTestId('mp-headline-input')
		await inputA.focus()
		await inputA.fill(`probe-a-${Date.now()}`)
		await expect(b.getByTestId('mp-lock-state')).toContainText(`Locked by ${nameA}.`, { timeout: 15_000 })
		console.log('B cursors BEFORE the submit click:', JSON.stringify(await cursorsOn(b)))

		// The click moves A's real mouse onto the button, which is itself a
		// cursor position A publishes.
		await a.getByTestId('mp-headline-submit').click()
		await a.waitForTimeout(2000)
		console.log('B cursors AFTER the submit click: ', JSON.stringify(await cursorsOn(b)))
		await inputA.blur()

		await moveCursor(a, 0.2, 0.3)
		await a.waitForTimeout(3000)
		console.log('B cursors AFTER moveCursor(0.2,0.3):', JSON.stringify(await cursorsOn(b)))

		await moveCursor(a, 0.65, 0.45)
		await a.waitForTimeout(3000)
		const after = await cursorsOn(b)
		console.log('B cursors AFTER moveCursor(.65,.45):', JSON.stringify(after))
		// Not a pin on the defect - a defect pinned as expected behaviour breaks
		// when it is fixed. This only proves the probe MEASURED something: a run
		// where the peer never appeared would otherwise print two empty lists and
		// read as evidence about cursors rather than as a join that never landed.
		expect(after.length, 'the probe must observe a peer cursor or it reports nothing').toBeGreaterThan(0)
	} finally {
		await Promise.allSettled([ctxA.close(), ctxB.close()])
	}
})
