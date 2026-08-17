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
const CONTROLS = '.btn, .input, .select, .file-input, .textarea, .tab'

test.describe('coarse-pointer control floor', () => {
	test('every rendered control meets the 44px floor on a touch device', async ({ browser }) => {
		test.setTimeout(180_000)
		const { context, page } = await openTouchPage(browser)
		const offenders = []
		let measured = 0
		try {
			for (const route of routes) {
				// No connection gate on purpose. This measures geometry, which the
				// server-rendered markup already determines, and waiting for every
				// page's socket would trade a fast geometric sweep for the slowest
				// and least reliable part of the suite. Controls that appear only
				// after data lands are simply not measured here.
				await page.goto(route, { waitUntil: 'domcontentloaded' })
				const found = await page.evaluate(({ selector, floor }) => {
					const visible = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0)
					return visible
						.map((el) => {
							const rect = el.getBoundingClientRect()
							// getAttribute, not className: on an SVG element className is
							// an SVGAnimatedString and would stringify to [object].
							const cls = el.getAttribute('class') ?? ''
							return { cls, text: (el.textContent ?? '').trim().slice(0, 24), w: rect.width, h: rect.height }
						})
						// Half a pixel of tolerance: a 44px control can measure 43.99
						// after subpixel layout, and failing that would be noise
						// rather than a control anyone can miss with a finger.
						.filter((m) => m.h < floor - 0.5 || (/(^|\s)btn(\s|$)/.test(m.cls) && m.w < floor - 0.5))
				}, { selector: CONTROLS, floor: FLOOR })

				for (const item of found) {
					offenders.push(`${route}  ${Math.round(item.w)}x${Math.round(item.h)}  "${item.text}"  [${item.cls}]`)
				}
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

		expect(
			offenders,
			`controls below the ${FLOOR}px coarse-pointer floor:\n${offenders.join('\n')}`
		).toEqual([])
	})
})
