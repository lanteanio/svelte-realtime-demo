// Ground truth for the one mechanism claim the coarse-pointer policy in
// src/app.css depends on.
//
// That comment has twice carried a false statement about how these controls
// behave, and each one sent the fix somewhere it did not need to go. The claim
// it rests on now is measured, and this is the measurement, kept reproducible
// so the next person can re-run it instead of inheriting another assertion.
//
// What it shows: an ::after on an appearance:none checkbox IS generated and IS
// hit-tested, for a positioned and a statically positioned control alike. So a
// pseudo-element overlay would extend the hit area. The policy uses a label
// anyway, on merit - it activates the control and reaches assistive technology,
// where an overlay does neither - not because the overlay cannot work.

import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test('an ::after overlay on a selector control is generated and hit-tested', async ({ page }) => {
	await page.goto('/demos/todos-rollback')
	await waitForWS(page)
	const result = await page.evaluate(() => {
		const style = document.createElement('style')
		style.textContent = '.probe::after { content: ""; position: absolute; left: 0; top: 0; width: 60px; height: 60px; background: rgba(255,0,0,.4); }'
		document.head.appendChild(style)
		// One control per wrapper, wrappers far apart, nothing else inside them.
		// An earlier version of this measurement put both in one wrapper, where
		// the two 60px overlays overlapped and each probe could land on the other
		// control - which read as "not hit-tested" and meant "measured wrong".
		const make = (id, top, positioned) => {
			const wrap = document.createElement('div')
			wrap.id = `${id}-wrap`
			wrap.style.cssText = `position:fixed; left:20px; top:${top}px; width:120px; height:120px; z-index:99999`
			const el = document.createElement('input')
			el.type = 'checkbox'
			el.id = id
			el.className = 'probe'
			el.style.cssText = `${positioned ? 'position:absolute; left:0; top:0;' : ''} width:20px; height:20px; appearance:none; margin:0`
			wrap.appendChild(el)
			document.body.appendChild(wrap)
			return el
		}
		const probe = (el) => {
			const r = el.getBoundingClientRect()
			// 40px out: outside the 20px drawn box, inside the 60px overlay.
			const hit = document.elementFromPoint(r.x + 40, r.y + 40)
			return {
				drawn: Math.round(r.width),
				hitsSelf: hit === el,
				hitId: hit ? hit.id || hit.tagName : null,
				content: getComputedStyle(el, '::after').content
			}
		}
		return { positioned: probe(make('p-pos', 120, true)), static: probe(make('p-static', 300, false)) }
	})
	console.log(`selector ::after probe: ${JSON.stringify(result)}`)

	for (const [name, r] of Object.entries(result)) {
		expect(r.drawn, `${name}: the drawn control stays at its own size`).toBe(20)
		expect(r.content, `${name}: the pseudo-element is generated`).toBe('""')
		expect(r.hitsSelf, `${name}: a point 40px out belongs to the control, so the overlay IS hit-tested`).toBe(true)
	}
})
