import { test, expect } from '@playwright/test'
import {
	DEMO_SLUGS,
	NOTE_COLORS,
	VERSION_06_SLUGS,
	boardCard,
	createBoardFromHome,
	demoTile,
	expectBoardCard,
	expectBoardPresence,
	navigateHome,
	navbarIdentity,
	openHome
} from './home-helpers.js'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

test.describe('home + gallery', () => {
	test('navbar identity, connection, default colors, GitHub, and theme all work', async ({ browser, page }) => {
		await openHome(page)
		await expect(page.locator('.navbar')).toBeVisible()
		await expect(page.locator('.navbar img[alt="Svelte"]')).toHaveAttribute('src', '/svelte_orange_logo_only.png')
		await expect(page.locator('.navbar a[href="/"]')).toContainText('Svelte Realtime Demo')
		await expect(page.locator('.navbar .tooltip[data-tip="open"]')).toHaveCount(1)

		const { text, token, cookie } = await navbarIdentity(page)
		expect(text.trim().split(/\s+/)).toHaveLength(2)
		expect(token.length).toBeGreaterThan(20)
		expect(() => JSON.parse(decodeURIComponent(token))).toThrow()
		expect(cookie.path).toBe('/')
		const iconColor = await page.locator('.navbar .font-medium').locator('..').locator('svg').evaluate((element) => getComputedStyle(element).color)
		expect(iconColor).toMatch(/^rgb\(\d+, \d+, \d+\)$/)

		const colorButtons = page.getByLabel('Set default note color')
		await expect(colorButtons).toHaveCount(NOTE_COLORS.length)
		for (const [index, color] of NOTE_COLORS.entries()) {
			const box = await colorButtons.nth(index).boundingBox()
			expect(box).toMatchObject({ width: 24, height: 24 })
			await colorButtons.nth(index).click()
			expect(await page.evaluate(() => localStorage.getItem('noteColor'))).toBe(color)
		}
		await page.reload()
		await waitForWS(page)
		expect(await page.evaluate(() => localStorage.getItem('noteColor'))).toBe(NOTE_COLORS.at(-1))
		await expect(page.getByLabel('Set default note color').nth(NOTE_COLORS.length - 1)).toHaveClass(/border-primary/)

		const shell = page.locator('.min-h-screen')
		const light = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
		const theme = page.locator('.theme-controller')
		await page.locator('label.swap').click()
		await expect(theme).toBeChecked()
		const dark = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
		expect(dark).not.toBe(light)
		await page.locator('label.swap').click()
		await expect(theme).not.toBeChecked()
		await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(light)

		const github = page.locator('.navbar a[href="https://github.com/lanteanio/svelte-realtime-demo"]')
		await expect(github).toHaveAttribute('target', '_blank')
		await expect(github).toHaveAttribute('rel', 'noopener')

		const ctx = await browser.newContext()
		const other = await ctx.newPage()
		try {
			await openHome(other)
			const otherIdentity = await navbarIdentity(other)
			expect(otherIdentity.token).not.toBe(token)
			expect(otherIdentity.text.trim().split(/\s+/)).toHaveLength(2)
			const counts = await Promise.all([page, other].map(async (current) => {
				const textValue = await current.locator('.navbar .text-xs.opacity-50').filter({ hasText: /online/ }).textContent({ timeout: 10_000 })
				return Number.parseInt(textValue, 10)
			}))
			for (const count of counts) expect(count).toBeGreaterThanOrEqual(2)
		} finally {
			await ctx.close()
		}

		const beforeNavigation = (await navbarIdentity(page)).token
		await demoTile(page, 'checkout').click()
		await page.waitForURL('/demos/checkout')
		expect((await navbarIdentity(page)).token).toBe(beforeNavigation)
		await page.reload()
		expect((await navbarIdentity(page)).token).toBe(beforeNavigation)
		await navigateHome(page)
	})

	test('product framing names the family and links the repos in text, not only as an icon', async ({ page }) => {
		await openHome(page)
		const realtime = page.getByTestId('framing-link-realtime')
		const adapter = page.getByTestId('framing-link-adapter')
		// Textual destinations, not a bare icon: the finding's requirement is
		// that a first-time visitor has a readable path off the page.
		await expect(realtime).toHaveText('svelte-realtime')
		await expect(realtime).toHaveAttribute('href', 'https://github.com/lanteanio/svelte-realtime')
		await expect(adapter).toHaveText('svelte-adapter-uws')
		await expect(adapter).toHaveAttribute('href', 'https://github.com/lanteanio/svelte-adapter-uws')
		for (const link of [realtime, adapter]) {
			await expect(link).toHaveAttribute('rel', 'noopener')
			await expect(link).toBeVisible()
		}
	})

	test('theme choice survives reload and new tabs, and falls back to the OS preference', async ({ browser }) => {
		const context = await browser.newContext()
		try {
			const page = await context.newPage()
			await openHome(page)
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

			// Toggling must STORE the choice, not merely apply it in place.
			await page.locator('label.swap').click()
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
			await expect.poll(() => page.evaluate(() => localStorage.getItem('theme'))).toBe('dark')

			// Capture the theme at the moment the document becomes interactive -
			// that is after the head bootstrap but before hydration, so it proves
			// the restore happens pre-paint rather than in the Svelte component.
			await page.addInitScript(() => {
				window.__themeAtInteractive = null
				document.addEventListener('readystatechange', () => {
					if (document.readyState === 'interactive' && window.__themeAtInteractive === null) {
						window.__themeAtInteractive = document.documentElement.dataset.theme ?? null
					}
				})
			})
			await page.reload()
			await waitForWS(page)
			expect(await page.evaluate(() => window.__themeAtInteractive)).toBe('dark')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
			await expect(page.locator('.theme-controller')).toBeChecked()

			// A second tab on the same origin restores the same choice.
			const secondTab = await context.newPage()
			await openHome(secondTab)
			await expect(secondTab.locator('html')).toHaveAttribute('data-theme', 'dark')
			await expect(secondTab.locator('.theme-controller')).toBeChecked()
			await secondTab.close()
		} finally {
			await context.close()
		}

		// With nothing stored, the OS preference decides - in both directions.
		for (const scheme of ['dark', 'light']) {
			const fresh = await browser.newContext({ colorScheme: scheme })
			try {
				const page = await fresh.newPage()
				await openHome(page)
				expect(await page.evaluate(() => localStorage.getItem('theme'))).toBeNull()
				await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
			} finally {
				await fresh.close()
			}
		}
	})

	test('create form enforces the 100-character cap and ignores whitespace-only Enter submission', async ({ page }) => {
		await openHome(page)
		const createInput = page.getByPlaceholder('New board name...')
		await expect(createInput).toHaveAttribute('maxlength', '100')
		await createInput.fill('   ')
		await createInput.press('Enter')
		await expect(page).toHaveURL(/\/$/)
		await expect(createInput).toHaveValue('   ')
	})

	test('gallery inventory, version badges, descriptions, filter results, and empty state are exact', async ({ page }) => {
		await openHome(page)
		// Counted by tile rather than by list child: the unfiltered catalog
		// interleaves section headings with the tiles.
		await expect(page.getByTestId('demos-list').locator('a[data-testid^="demos-tile-"]')).toHaveCount(DEMO_SLUGS.length)
		await expect(page.getByTestId('demos-filter')).toHaveAttribute('autocomplete', 'off')
		for (const slug of DEMO_SLUGS) {
			const tile = demoTile(page, slug)
			await expect(tile).toHaveAttribute('href', `/demos/${slug}`)
			await expect(tile.locator('[data-testid="tile-version"]')).toHaveText(VERSION_06_SLUGS.has(slug) ? '^0.6' : '^0.5')
			await expect(tile.locator('.font-semibold')).not.toHaveText('')
			await expect(tile.locator('[data-testid="tile-desc"]')).not.toHaveText('')
		}

		// A tile description is the entry path to its demo, so an API named
		// here that does not exist sends a visitor looking for something they
		// will never find - and worse, contradicts what the demo itself
		// teaches once they arrive. cluster-cron advertised
		// `live.configureCron({ leader })`; the export is the standalone
		// `configureCron`, which is what the demo's own wiring panel shows.
		const clusterCron = demoTile(page, 'cluster-cron').locator('[data-testid="tile-desc"]')
		await expect(clusterCron).toContainText('configureCron({ leader })')
		await expect(clusterCron).not.toContainText('live.configureCron')
		// ...and no other tile reintroduces the same non-existent name.
		const descriptions = await page.getByTestId('tile-desc')
			.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''))
		expect(
			descriptions.filter((text) => text.includes('live.configureCron')),
			'a gallery description names an export that does not exist'
		).toEqual([])

		const filter = page.getByTestId('demos-filter')
		await filter.fill('CRDT')
		await expect(page.getByTestId('demos-filter-count')).toHaveText('2 / 34')
		await expect(page.getByTestId('demos-list').locator('a')).toHaveCount(2)
		await expect(demoTile(page, 'collab-editor')).toBeVisible()
		await expect(demoTile(page, 'kanban')).toBeVisible()

		await filter.fill('cron')
		await expect(page.getByTestId('demos-filter-count')).toHaveText('4 / 34')
		for (const slug of ['notifications', 'news', 'jobs', 'cluster-cron']) await expect(demoTile(page, slug)).toBeVisible()

		await filter.fill('no-such-realtime-demo')
		await expect(page.getByTestId('demos-filter-count')).toHaveText('0 / 34')
		await expect(page.getByTestId('demos-empty')).toHaveText('No demos match "no-such-realtime-demo".')
		await filter.fill('')
		await expect(page.getByTestId('demos-filter-count')).toHaveText('34 / 34')
	})

	test('button/Enter board creation, live cards, presence sorting, leave cleanup, and card opening converge', async ({ browser }) => {
		test.setTimeout(120_000)
		const ctxA = await browser.newContext()
		const ctxObserver = await browser.newContext()
		const ctxJoiner = await browser.newContext()
		const a = await ctxA.newPage()
		const observer = await ctxObserver.newPage()
		let joiner
		const firstTitle = `Home first ${Date.now()}`
		const secondTitle = `Home second ${Date.now()}`
		try {
			await Promise.all([openHome(a), openHome(observer)])
			const firstPath = await createBoardFromHome(a, firstTitle, 'button')
			await expectBoardCard(observer, firstPath, firstTitle)
			await expectBoardPresence(observer, firstPath, 1)
			await navigateHome(a)
			await expectBoardPresence(observer, firstPath, 0)

			const secondPath = await createBoardFromHome(a, secondTitle, 'enter')
			await expectBoardCard(observer, secondPath, secondTitle)
			await expectBoardPresence(observer, secondPath, 1)
			await navigateHome(a)
			await expectBoardPresence(observer, secondPath, 0)

			await boardCard(a, firstPath).click()
			await a.waitForURL(firstPath)
			await expectBoardPresence(observer, firstPath, 1)
			// The presence badge updates live but the sort key is deliberately
			// settled (see the debounce in src/routes/+page.svelte) so rows do
			// not jump out from under an aiming cursor. Poll for the order
			// instead of reading it the instant the badge lands.
			await expect.poll(async () => {
				const ordered = await observer.locator('a.card[href^="/board/"]').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')))
				return ordered.indexOf(firstPath) < ordered.indexOf(secondPath)
			}).toBe(true)

			joiner = await ctxJoiner.newPage()
			await joiner.goto(firstPath)
			await waitForWS(joiner)
			await expectBoardPresence(observer, firstPath, 2)
			await ctxJoiner.close()
			await expectBoardPresence(observer, firstPath, 1)
			await navigateHome(a)
			await expectBoardPresence(observer, firstPath, 0)

			await boardCard(observer, firstPath).click()
			await observer.waitForURL(firstPath)
			await expect(observer.locator('h1')).toHaveText(firstTitle)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxObserver.close(), ctxJoiner.close()])
		}
	})

	test('the demos rail stays horizontal through the 640-1023 tablet band and fixes only at desktop width', async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 900 })
		await page.goto('/demos/topk')
		await waitForWS(page)

		const layout = async () => page.evaluate(() => {
			const aside = document.querySelector('.demos-aside')
			const content = document.querySelector('.demos-content')
			const list = document.querySelector('.demos-list')
			return {
				asidePosition: getComputedStyle(aside).position,
				contentMarginLeft: getComputedStyle(content).marginLeft,
				listDirection: getComputedStyle(list).flexDirection
			}
		})

		for (const width of [640, 768]) {
			await page.setViewportSize({ width, height: 900 })
			await expect.poll(layout).toEqual({
				asidePosition: 'static',
				contentMarginLeft: '0px',
				listDirection: 'row'
			})
		}

		await page.setViewportSize({ width: 1024, height: 900 })
		await expect.poll(layout).toEqual({
			asidePosition: 'fixed',
			contentMarginLeft: '208px',
			listDirection: 'column'
		})
	})

	test('every gallery tile navigates to its demo with the matching active switcher entry', async ({ page }) => {
		test.setTimeout(300_000)
		await openHome(page)
		for (const slug of DEMO_SLUGS) {
			await demoTile(page, slug).click()
			await page.waitForURL(`/demos/${slug}`, { timeout: 15_000 })
			await expect(page.getByTestId('demos-nav').locator('a[data-testid^="demos-nav-link-"]')).toHaveCount(DEMO_SLUGS.length)
			const activeLink = page.getByTestId(`demos-nav-link-${slug}`)
			await expect(activeLink).toHaveAttribute('aria-current', 'page')
			const heading = page.getByRole('heading', { level: 1 }).first()
			await expect(heading).toBeVisible({ timeout: 15_000 })
			const leadWord = (text) => text.trim().split(/[\s:]+/)[0].toLocaleLowerCase()
			expect(leadWord(await activeLink.innerText()), `${slug} switcher/H1 naming`).toBe(leadWord(await heading.innerText()))
			const explainer = page.locator('.demo-explainer, aside.text-xs.opacity-50.leading-relaxed')
			await expect(explainer).toHaveCount(1)
			expect(await explainer.evaluate((element) => {
				const style = getComputedStyle(element)
				return { fontSize: style.fontSize, opacity: style.opacity }
			})).toEqual({ fontSize: '14px', opacity: '0.7' })
			await page.locator('.demos-home-link').click()
			await page.waitForURL(/\/$/)
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await page.goto('/demos/alarms')
			await waitForWS(page)
			await expectTouchTarget(page.locator('.demos-link').first(), { minWidth: 0 })
			await expectTouchTarget(page.locator('.demos-home-link'), { minWidth: 0 })
		} finally {
			await context.close()
		}
	})
})
