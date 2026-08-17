import { test, expect } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A placeholder is not a label, and this checks that no control is relying on
// one to say what it is.
//
// The reasons are not stylistic. A placeholder disappears the moment the field
// has content, so the only description of the field is gone exactly when a
// visitor is reviewing what they typed; it is drawn in a muted colour that
// fails contrast by design; and it is not a dependable accessible name across
// assistive technology. A control whose only description is its placeholder is
// therefore unnamed for anyone not looking at an empty field.
//
// The name may be visible or not - an aria-label is a real name, and for a
// compose field beside its own send button a visible label would duplicate the
// surrounding heading rather than add anything. What is asserted here is that a
// name EXISTS, not how it is presented.

const DEMOS = fileURLToPath(new URL('../../src/routes/demos', import.meta.url))
const routes = [
	'/',
	...readdirSync(DEMOS, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `/demos/${entry.name}`)
		.sort()
]

test.describe('accessible names', () => {
	test('no control uses its placeholder as its only name', async ({ page }) => {
		test.setTimeout(180_000)
		const unnamed = []
		let measured = 0

		for (const route of routes) {
			// Geometry is not involved, so this needs neither a connection gate
			// nor a touch context: the markup the server sends already decides
			// whether a control carries a name.
			await page.goto(route, { waitUntil: 'domcontentloaded' })
			const found = await page.evaluate(() => {
				const controls = [...document.querySelectorAll('input[placeholder], textarea[placeholder], select[placeholder]')]
				return {
					total: controls.length,
					// `labels` is the DOM's own association, so it covers both a
					// `for=` reference and a wrapping label without this having to
					// re-implement either rule.
					unnamed: controls
						.filter((el) => !(
							el.getAttribute('aria-label')?.trim()
							|| el.getAttribute('aria-labelledby')?.trim()
							|| (el.labels && el.labels.length > 0)
						))
						.map((el) => ({ tag: el.tagName.toLowerCase(), placeholder: el.getAttribute('placeholder') ?? '' }))
				}
			})
			measured += found.total
			for (const item of found.unnamed) {
				unnamed.push(`${route}  <${item.tag}>  placeholder="${item.placeholder.slice(0, 48)}"`)
			}
		}

		// Same self-guard as the touch sweep: a selector that stopped matching
		// would report success while checking nothing, and a green that means
		// "measured nothing" would retire the policy silently.
		expect(measured, 'the sweep must find placeholder controls or it proves nothing').toBeGreaterThan(5)

		expect(
			unnamed,
			`controls whose only description is a placeholder:\n${unnamed.join('\n')}`
		).toEqual([])
	})
})
