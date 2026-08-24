import { test, expect } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openTouchPage } from './helpers.js'

// The coarse-pointer control floor, enforced across the whole app rather than
// asserted one control at a time.
//
// The per-page touch assertions each pin ONE control on ONE page, which is why
// a hundred controls could sit below the floor while every one of those tests
// passed. This measures every control the app actually renders, so the policy
// is checked where it is stated - once, globally - and a page that regresses is
// named with the offending control rather than the suite going quietly green.
//
// Routes come from the filesystem, not a hand-kept list: a new demo is covered
// the moment it exists. A list would have to be remembered, and the finding
// this exists for is precisely a rule nobody remembered.

const DEMOS = fileURLToPath(new URL('../../src/routes/demos', import.meta.url))
const routes = [
	'/',
	...readdirSync(DEMOS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `/demos/${entry.name}`)
		.sort()
]

// The floor, and the selector the policy is written against. Kept in step with
// the @media (pointer: coarse) block in src/app.css by hand, because a test
// that derived its own selector from the stylesheet would pass by construction.
const FLOOR = 44
const CONTROLS = '.btn, .input, .select, .file-input, .textarea, .tab, .range, .checkbox, .toggle'
// A checkbox and a toggle are activated by their label as well as their box, so
// the label is a real target and the policy puts the floor there, leaving the
// drawn control alone. Measuring the box for these would flag a control whose
// target is genuinely large enough. Direct parent only, matching the
// `label:has(> .checkbox, > .toggle)` rule the stylesheet actually states - a
// label wrapping a whole row is not the target for any one control in it.
const LABEL_ACTIVATED = '.checkbox, .toggle'
// The other half of the label policy: the floor lands on the label so the
// DRAWN control keeps its designed size, and this is the ceiling that pins it.
// The sizes this app uses draw at 20-24px (checkbox-sm 20, checkbox-md 24,
// toggle-sm 20, toggle 24), so 28 sits just above every designed size and far
// below the floor: a control grown to carry the floor itself - the redesign
// the label rule exists to prevent - cannot pass it, while every designed
// size clears it. A toggle is designed WIDER than the floor (about 48px), so
// width is pinned for the checkbox only; height is pinned for both.
const DRAWN_CEILING = 28

test.describe('coarse-pointer control floor', () => {
	test('every rendered control meets the 44px floor on a touch device', async ({ browser }) => {
		test.setTimeout(180_000)
		const { context, page } = await openTouchPage(browser)
		const offenders = []
		const redesigned = []
		let measured = 0
		let drawnMeasured = 0
		try {
			for (const route of routes) {
				// No connection gate on purpose. This measures geometry, which the
				// server-rendered markup already determines, and waiting for every
				// page's socket would trade a fast geometric sweep for the slowest
				// and least reliable part of the suite. Controls that appear only
				// after data lands are simply not measured here.
				await page.goto(route, { waitUntil: 'domcontentloaded' })
				const found = await page.evaluate(({ selector, labelActivated, floor, drawnCeiling }) => {
					const visible = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0)
					const measurements = visible.map((el) => {
						const parent = el.parentElement
						const target = el.matches(labelActivated) && parent?.tagName === 'LABEL' ? parent : el
						const rect = target.getBoundingClientRect()
						// getAttribute, not className: on an SVG element className is
						// an SVGAnimatedString and would stringify to [object].
						const cls = el.getAttribute('class') ?? ''
						return { el, cls, text: (el.textContent ?? '').trim().slice(0, 24), w: rect.width, h: rect.height }
					})
					// Half a pixel of tolerance: a 44px control can measure 43.99
					// after subpixel layout, and failing that would be noise
					// rather than a control anyone can miss with a finger.
					const low = measurements
						.filter((m) => m.h < floor - 0.5 || (/(^|\s)btn(\s|$)/.test(m.cls) && m.w < floor - 0.5))
						.map(({ el, ...m }) => m)
					// The drawn box of a label-activated control, measured on the
					// control ITSELF rather than on its target. The floor check above
					// is satisfied just as well by a control grown to 44px as by a
					// label carrying the floor around an unchanged one - and the grown
					// control is the redesign the label rule exists to prevent, so the
					// target check alone admits exactly the state the policy forbids.
					const grown = []
					let drawnChecked = 0
					for (const m of measurements) {
						if (!m.el.matches(labelActivated)) continue
						drawnChecked++
						const own = m.el.getBoundingClientRect()
						const widthPinned = /(^|\s)checkbox(\s|$)/.test(m.cls)
						if (own.height > drawnCeiling + 0.5 || (widthPinned && own.width > drawnCeiling + 0.5)) {
							grown.push({ cls: m.cls, w: own.width, h: own.height })
						}
					}
					return { low, grown, drawnChecked }
				}, { selector: CONTROLS, labelActivated: LABEL_ACTIVATED, floor: FLOOR, drawnCeiling: DRAWN_CEILING })

				for (const item of found.low) {
					offenders.push(`${route}  ${Math.round(item.w)}x${Math.round(item.h)}  "${item.text}"  [${item.cls}]`)
				}
				for (const item of found.grown) {
					redesigned.push(`${route}  ${Math.round(item.w)}x${Math.round(item.h)}  [${item.cls}]`)
				}
				drawnMeasured += found.drawnChecked
				measured += await page.evaluate(
					(selector) => [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0).length,
					CONTROLS
				)
			}
		} finally {
			await context.close()
		}

		// Guard the sweep against itself. If the selector drifts away from the
		// policy, or the routes stop resolving, this test would find nothing and
		// report success - a green that means "measured nothing" is worse than a
		// red, because the floor it claims to defend would be gone silently. The
		// bound is deliberately far below the ~230 controls actually rendered, so
		// it catches collapse rather than tracking the design.
		expect(measured, 'the sweep must measure real controls or it proves nothing').toBeGreaterThan(100)
		expect(routes.length, 'every demo route must be swept').toBeGreaterThan(30)
		// The same guard for the redesign check. Most checkboxes and toggles in
		// this app appear only after data lands, so the sweep - which stops at
		// domcontentloaded on purpose - sees the server-rendered minority: four,
		// measured. The bound catches the count collapsing to zero (a drifted
		// selector, pages that stopped rendering) without tracking the design;
		// what makes four enough is that the growth this checks for could only
		// come from a stylesheet rule, and a stylesheet rule grows every
		// instance, including these. The one data-dependent control with full
		// geometry coverage is pinned in its own spec.
		expect(drawnMeasured, 'the redesign check must measure real selector controls or it proves nothing').toBeGreaterThan(3)

		expect(
			offenders,
			`controls below the ${FLOOR}px coarse-pointer floor:\n${offenders.join('\n')}`
		).toEqual([])
		expect(
			redesigned,
			`selector controls grown past their designed size (the label is the target; the drawn box must stay as designed):\n${redesigned.join('\n')}`
		).toEqual([])
	})
})
