import { test, expect } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createBoard, openTouchPage, waitForBoardReady, waitForWS } from './helpers.js'
import { openSale } from './flash-sales-helpers.js'
import { openKanban, deleteCard } from './kanban-helpers.js'

// The coarse-pointer control floor, enforced across the whole app rather than
// asserted one control at a time.
//
// The per-page touch assertions each pin ONE control on ONE page, which is why
// a hundred controls could sit below the floor while every one of those tests
// passed. The server-rendered census covers the homepage and top-level demos.
// The hydrated pass also creates a board and opens its rename editor, so the policy
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
// DRAWN control keeps its designed size - and "designed size" is a number,
// not a ceiling. A ceiling admits every redesign smaller than itself: a
// checkbox moved from checkbox-md to checkbox-lg draws a visibly different
// 28px control and clears a 28px ceiling exactly. So the sweep pins two
// separate facts, because they fail for different edits. Each measured
// control must draw at the exact size daisyUI designs its variant at - a
// stylesheet rule growing the box moves it off that number. And each route
// must render exactly the variants the design states - a markup swap to a
// larger variant draws correctly for its NEW variant, so only the census
// catches it.
//
// Hand-kept, like the selector above, because a test that read the sizes
// from the stylesheet would follow any redesign and pass by construction.
// The numbers are daisyUI's: a checkbox is square at --size, 4px per step
// from xs 16 to xl 32; a toggle is --size tall and 1.75 * size - 2px wide
// at this app's 1px selector border.
const DESIGNED_SIZE = {
	'checkbox-xs': { w: 16, h: 16 },
	'checkbox-sm': { w: 20, h: 20 },
	'checkbox-md': { w: 24, h: 24 },
	'checkbox-lg': { w: 28, h: 28 },
	'checkbox-xl': { w: 32, h: 32 },
	'toggle-xs': { w: 26, h: 16 },
	'toggle-sm': { w: 33, h: 20 },
	'toggle-md': { w: 40, h: 24 },
	'toggle-lg': { w: 47, h: 28 },
	'toggle-xl': { w: 54, h: 32 }
}
// The selector controls each route's server-rendered markup draws, which is
// all the initial census measures: its context runs no page script, so a control that
// appears only after hydration or after data lands never enters it, however
// fast that data arrives. Of the app's checkboxes and toggles, only the todo
// row checkbox on /demos/todos-rollback is of that kind. The hydrated pass
// below measures controls after data arrives, without asserting a row census.
// A route not listed renders none at load,
// and a control appearing on an unlisted route fails the sweep until its
// variant is stated here. This census is also the sweep's proof it measured
// anything at all: if the selector drifts or these pages stop rendering, the
// routes below come up empty and the comparison goes red instead of the sweep
// vouching for controls it never saw.
const RENDERED_AT_LOAD = {
	'/demos/arena': ['toggle-sm'],
	'/demos/flags': ['toggle-sm', 'toggle-sm'],
	'/demos/todos-rollback': ['toggle-md']
}


async function measureControls(page) {
	return page.evaluate(({ selector, labelActivated, floor }) => {
		const visible = [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
		const measurements = visible.map((el) => {
			const parent = el.parentElement
			const target = el.matches(labelActivated) && parent?.tagName === 'LABEL' ? parent : el
			const rect = target.getBoundingClientRect()
			// getAttribute, not className: on an SVG element className is
			// an SVGAnimatedString and would stringify to [object].
			const cls = el.getAttribute('class') ?? ''
			return { el, cls, labelTarget: target !== el, text: (el.textContent ?? '').trim().slice(0, 24), w: rect.width, h: rect.height }
		})
		// Half a pixel of tolerance: a 44px control can measure 43.99
		// after subpixel layout, and failing that would be noise
		// rather than a control anyone can miss with a finger.
		const low = measurements
			.filter((m) => m.h < floor - 0.5 || ((m.labelTarget || /(^|\s)btn(\s|$)/.test(m.cls)) && m.w < floor - 0.5))
			.map(({ el, labelTarget, ...m }) => m)
		// The drawn box of a label-activated control, measured on the
		// control ITSELF rather than on its target. The floor check above
		// is satisfied just as well by a control grown to 44px as by a
		// label carrying the floor around an unchanged one - and the grown
		// control is the redesign the label rule exists to prevent, so the
		// target check alone admits exactly the state the policy forbids.
		// Each control reports which size variant its class declares; the
		// comparison against the designed numbers happens outside, where
		// the failure can name the route.
		const drawn = []
		for (const m of measurements) {
			if (!m.el.matches(labelActivated)) continue
			const own = m.el.getBoundingClientRect()
			const type = m.el.matches('.checkbox') ? 'checkbox' : 'toggle'
			const tokens = m.cls.split(/\s+/)
			const isSize = (t) => new RegExp(`^${type}-(xs|sm|md|lg|xl)$`).test(t)
			// On this coarse rung a pointer-coarse: size variant overrides
			// the plain one, exactly as its media-scoped rule does in the
			// stylesheet. Two size tokens in the same bucket have no single
			// stylesheet winner worth modelling, so the joined name simply
			// misses the designed-size table and gets reported as-is.
			const coarse = tokens.filter((t) => t.startsWith('pointer-coarse:') && isSize(t.slice(15)))
			const plain = tokens.filter(isSize)
			const bucket = coarse.length ? coarse.map((t) => t.slice(15)) : plain
			const variant = bucket.length === 0 ? `${type}-md` : bucket.length === 1 ? bucket[0] : bucket.join('+')
			drawn.push({ cls: m.cls, variant, w: own.width, h: own.height })
		}
		return { low, drawn, count: measurements.length }
	}, { selector: CONTROLS, labelActivated: LABEL_ACTIVATED, floor: FLOOR })
}

test.describe('coarse-pointer control floor', () => {
	test('every server-rendered control meets the 44px floor on a touch device', async ({ browser }) => {
		test.setTimeout(180_000)
		// Page scripts off: the sweep measures server-rendered markup. With
		// scripts on, a page that hydrates and receives data before the
		// measurement draws controls the census does not state, such as a
		// leftover todo's checkbox on /demos/todos-rollback.
		const { context, page } = await openTouchPage(browser, { javaScriptEnabled: false })
		// This test-owned document has no CSP, so it checks the context's
		// script setting even if the application's policy later changes.
		await page.goto('data:text/html,<script>window.__sweepScriptRan=true</script>')
		expect(await page.evaluate(() => window.__sweepScriptRan === true), 'the census context must disable page scripts independently of CSP').toBe(false)
		let delayedStylesheets = 0
		await page.route('**/*.css', async (route) => {
			delayedStylesheets++
			if (delayedStylesheets === 1) await new Promise((resolve) => setTimeout(resolve, 1500))
			await route.continue()
		})
		const offenders = []
		const routeDrawn = {}
		let measured = 0
		try {
			for (const route of routes) {
				// `load`, not domcontentloaded: with scripts on, the inline boot
				// script waits for the stylesheets above it and holds
				// domcontentloaded back until they apply; with scripts off nothing
				// does, so domcontentloaded can fire before they have.
				await page.goto(route, { waitUntil: 'load' })
				expect(await page.evaluate(() => ({
					theme: document.documentElement.getAttribute('data-theme'),
					booted: Object.keys(window).some((key) => key.startsWith('__sveltekit_')),
					stylesLoaded: [...document.querySelectorAll('link[rel="stylesheet"]')].every((link) => link.sheet !== null)
				})), `${route}: page scripts stay off and stylesheets finish loading`).toEqual({ theme: null, booted: false, stylesLoaded: true })
				const found = await measureControls(page)

				for (const item of found.low) {
					offenders.push(`${route}  ${Math.round(item.w)}x${Math.round(item.h)}  "${item.text}"  [${item.cls}]`)
				}
				if (found.drawn.length > 0) routeDrawn[route] = found.drawn
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
		// bound is deliberately far below the ~240 controls actually rendered, so
		// it catches collapse rather than tracking the design.
		expect(delayedStylesheets, 'the load wait must see a delayed stylesheet').toBeGreaterThan(0)
		expect(measured, 'the sweep must measure real controls or it proves nothing').toBeGreaterThan(100)
		expect(routes.length, 'every demo route must be swept').toBeGreaterThan(30)

		// The two halves of the redesign check. Sizes first: every measured
		// control must draw at the exact designed size of the variant its class
		// declares, so a stylesheet rule growing the box is named with its
		// number. Then the census: every route must render exactly the variants
		// the design states, so a control swapped to a larger variant - which
		// draws correctly for its new class and passes the size half - is named
		// by the swap itself. The census doubles as the measured-something
		// guard: a sweep that stops seeing controls fails it on every listed
		// route rather than reporting an empty, green pass.
		const redesigned = []
		for (const [route, items] of Object.entries(routeDrawn)) {
			for (const item of items) {
				const designed = DESIGNED_SIZE[item.variant]
				if (!designed) {
					redesigned.push(`${route}  [${item.cls}]  "${item.variant}" has no designed size stated in this sweep`)
				} else if (Math.abs(item.w - designed.w) > 0.5 || Math.abs(item.h - designed.h) > 0.5) {
					redesigned.push(
						`${route}  [${item.cls}]  draws ${Math.round(item.w)}x${Math.round(item.h)}, ${item.variant} is designed ${designed.w}x${designed.h}`
					)
				}
			}
		}
		const censusDiff = []
		for (const route of [...new Set([...Object.keys(routeDrawn), ...Object.keys(RENDERED_AT_LOAD)])].sort()) {
			const rendered = (routeDrawn[route] ?? []).map((item) => item.variant).sort()
			const stated = [...(RENDERED_AT_LOAD[route] ?? [])].sort()
			if (rendered.join(',') !== stated.join(',')) {
				censusDiff.push(`${route}  renders [${rendered.join(', ')}] at load, the design states [${stated.join(', ')}]`)
			}
		}

		expect(
			offenders,
			`controls below the ${FLOOR}px coarse-pointer floor:\n${offenders.join('\n')}`
		).toEqual([])
		expect(
			redesigned,
			`selector controls off their designed size (the label is the target; the drawn box must stay exactly as designed):\n${redesigned.join('\n')}`
		).toEqual([])
		expect(
			censusDiff,
			`selector controls at load diverged from the stated design (a control moved to another variant draws that variant's size, so only the census catches the swap):\n${censusDiff.join('\n')}`
		).toEqual([])
	})
})

test('controls rendered after hydration meet the touch floor and drawn sizes', async ({ browser }) => {
	test.setTimeout(180_000)
	const { context, page } = await openTouchPage(browser)
	const checked = new Set()
	let isolatedKanban = false
	try {
		const boardPath = await createBoard(page, `Touch controls ${Date.now()}`)
		for (const route of [...routes, boardPath]) {
			await page.goto(route, { waitUntil: 'load' })
			await waitForWS(page)
			let todoRow
			try {
				if (route === boardPath) {
					await waitForBoardReady(page)
					await expect(page.getByRole('button', { name: 'Rename board', exact: true })).toBeVisible()
					await expect(page.getByTestId('board-add-note')).toBeVisible()
					checked.add('board')
				} else if (route === '/demos/denials') {
					await page.getByTestId('switch-acme').click()
					await expect(page.getByTestId('append-input')).toBeVisible()
					await expect(page.getByTestId('append-button')).toBeVisible()
					checked.add('denials')
				} else if (route === '/demos/kanban') {
					await openKanban(page)
					// This document is shared by every visitor. Only the local harness
					// owns its entire fixture; remote opt-in does not grant that ownership.
					isolatedKanban = process.env.LOCAL_E2E === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(page.url()).hostname)
					if (isolatedKanban) {
						const ids = await page.locator('[data-testid^="kb-card-"]').evaluateAll((rows) => rows.map((row) => row.dataset.testid.slice('kb-card-'.length)))
						for (const id of ids) await deleteCard(page, id)
						await expect(page.getByTestId('kb-seed-button')).toBeVisible()
						checked.add('kanban')
					} else {
						test.info().annotations.push({ type: 'coverage-skipped', description: 'Kanban empty-board seed control requires isolated LOCAL_E2E fixtures; existing cards are preserved.' })
					}
				} else if (route === '/demos/flash-sales') {
					await openSale(page)
					for (const product of ['phone', 'watch', 'speaker']) await expect(page.getByTestId(`product-buy-${product}`)).toBeVisible()
					checked.add('flash-sales')
				} else if (route === '/demos/todos-rollback') {
					await expect(page.getByTestId('todos')).toHaveAttribute('data-hydrated', 'true')
					const text = `touch-${Date.now()}`
					await page.getByTestId('todo-input').fill(text)
					todoRow = page.getByTestId('todos').locator('li').filter({ hasText: text })
					await page.getByTestId('add-button').click()
					await expect(todoRow.locator('[data-testid^="todo-toggle-"]')).toBeVisible()
					await expect(todoRow.locator('[data-testid^="todo-remove-"]')).toBeVisible()
					await expect(page.getByTestId('clear-button')).toBeVisible()
					checked.add('todos-rollback')
				}
				const found = await measureControls(page)
				expect(found.count, `${route}: hydrated pass must measure visible controls`).toBeGreaterThan(0)
				expect(found.low, `${route}: hydrated controls below the touch floor`).toEqual([])
				for (const item of found.drawn) {
					const designed = DESIGNED_SIZE[item.variant]
					expect(designed, `${route}: ${item.variant} must name a designed size`).toBeDefined()
					expect(Math.abs(item.w - designed.w), `${route}: ${item.cls} drawn width`).toBeLessThanOrEqual(0.5)
					expect(Math.abs(item.h - designed.h), `${route}: ${item.cls} drawn height`).toBeLessThanOrEqual(0.5)
				}
				if (route === boardPath) {
					await page.getByRole('button', { name: 'Rename board', exact: true }).click()
					const editor = page.getByRole('textbox', { name: 'Board name', exact: true })
					await expect(editor).toBeVisible()
					const editing = await measureControls(page)
					expect(editing.count, 'board rename state must measure visible controls').toBeGreaterThan(0)
					expect(editing.low, 'board rename controls below the touch floor').toEqual([])
					await editor.press('Enter')
				}
			} finally {
				if (todoRow && await todoRow.count() > 0) {
					await todoRow.locator('[data-testid^="todo-remove-"]').click({ timeout: 5_000 })
					await expect(todoRow).toHaveCount(0, { timeout: 5_000 })
				}
			}
		}
		expect([...checked].sort()).toEqual(['board', 'denials', 'flash-sales', ...(isolatedKanban ? ['kanban'] : []), 'todos-rollback'])
	} finally {
		await context.close()
	}
})
