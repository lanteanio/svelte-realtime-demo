import { test, expect } from '@playwright/test'
import {
	clickRangeAt,
	closestRemote,
	collectShooterErrors,
	holdKey,
	openShooter,
	ownPosition,
	remoteByKey,
	shooterStats,
	shootRenderedTarget
} from './shooter-helpers.js'

test.describe('/demos/shooter', () => {
	test('renders the whole range, scoreboard, latency control, disclosure, and source link', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)
		await expect(page.getByRole('heading', { name: 'Shooter: lag-compensated hits' })).toBeVisible()
		await expect(page.getByTestId('sh-range')).toHaveAttribute('role', 'img')
		await expect(page.getByTestId('sh-target')).toHaveCount(8)
		await expect(page.getByTestId('sh-me')).toBeVisible()
		await expect(page.getByText('WASD / arrows to move; click the arena or press Space to shoot.')).toBeVisible()
		await expect(page.getByRole('heading', { name: 'Score' })).toBeVisible()
		expect(await shooterStats(page)).toEqual({ score: 0, shots: 0, hits: 0 })
		// Your own hp is rendered (victims see damage happen to them), and the
		// arena says which dot is you before the first shot commits to a ray.
		await expect(page.getByTestId('sh-hp')).toHaveText(/^hp: \d$/)
		await expect(page.getByTestId('sh-you-label')).toBeVisible()
		const slider = page.getByTestId('sh-lag')
		await expect(slider).toHaveAttribute('min', '0')
		// The slider runs past the marked value, but the mark is a label for
		// maxRewindMs rather than a threshold in this control: the render-time
		// a shot carries is stamped at send time, so a delay invented on this
		// page never reaches the server's rewind age. Asserting a miss beyond
		// the mark would be asserting a mechanism the transport does not have.
		await expect(slider).toHaveAttribute('max', '600')
		await expect(slider).toHaveAttribute('step', '50')
		await expect(page.getByTestId('sh-lag-cap-mark')).toHaveText('400 = cap')
		await expect(slider).toHaveValue('0')
		await expect(page.getByRole('heading', { name: 'Extra latency: 0ms' })).toBeVisible()
		await expect(page.getByText('maxRewindMs: 400', { exact: false }).first()).toBeVisible()
		await expect(page.getByRole('link', { name: 'shooter.js' })).toHaveAttribute('href', /src\/live\/demos\/shooter\.js$/)
		expect(errors).toEqual([])
	})

	test('WASD and arrow controls move the predicted own dot in every direction', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)
		const start = await ownPosition(page)
		await holdKey(page, 'd')
		await expect.poll(async () => (await ownPosition(page)).x).toBeGreaterThan(start.x)
		const afterRight = await ownPosition(page)
		await holdKey(page, 'ArrowDown')
		await expect.poll(async () => (await ownPosition(page)).y).toBeGreaterThan(afterRight.y)
		const afterDown = await ownPosition(page)
		await holdKey(page, 'a')
		await expect.poll(async () => (await ownPosition(page)).x).toBeLessThan(afterDown.x)
		const afterLeft = await ownPosition(page)
		await holdKey(page, 'ArrowUp')
		await expect.poll(async () => (await ownPosition(page)).y).toBeLessThan(afterLeft.y)
		expect(errors).toEqual([])
	})

	test('latency slider maps 0-400ms and defers each shot until its selected send delay', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)
		const slider = page.getByTestId('sh-lag')

		await slider.fill('200')
		await expect(page.getByRole('heading', { name: 'Extra latency: 200ms' })).toBeVisible()
		await shootRenderedTarget(page)
		expect((await shooterStats(page)).shots).toBe(0)
		await expect.poll(async () => (await shooterStats(page)).shots).toBe(1)

		await slider.fill('400')
		await expect(page.getByRole('heading', { name: 'Extra latency: 400ms' })).toBeVisible()
		await shootRenderedTarget(page)
		await page.waitForTimeout(200)
		expect((await shooterStats(page)).shots).toBe(1)
		await expect.poll(async () => (await shooterStats(page)).shots).toBe(2)

		await slider.fill('0')
		await expect(page.getByRole('heading', { name: 'Extra latency: 0ms' })).toBeVisible()
		await clickRangeAt(page, 320, 210)
		await expect.poll(async () => (await shooterStats(page)).shots).toBe(3)
		expect(errors).toEqual([])
	})

	test('Space fires without a pointer, and a lagged send still acknowledges the input instantly', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)

		const slider = page.getByTestId('sh-lag')
		await slider.fill('400')
		await expect(page.getByRole('heading', { name: 'Extra latency: 400ms' })).toBeVisible()
		// fill() leaves focus on the range input, whose keys are deliberately
		// not fire keys (arrows must keep adjusting the slider); the shoot
		// path under test is the page-level one.
		await slider.blur()

		await page.keyboard.press('Space')
		// The receipt ring must appear at once, while the shot itself is still
		// sitting in its 400ms send delay - instant acknowledgment is the
		// point, so the ring cannot wait for the send.
		await expect(page.getByTestId('sh-click-ring')).toBeVisible()
		expect((await shooterStats(page)).shots).toBe(0)
		await expect.poll(async () => (await shooterStats(page)).shots).toBe(1)
		expect(errors).toEqual([])
	})

	test('phone visitors get a touch pad that moves the dot the keyboard moves', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		const errors = collectShooterErrors(page)
		await openShooter(page)
		const pad = page.getByTestId('sh-move-pad')
		await expect(pad).toBeVisible()
		await expect(pad.getByRole('button')).toHaveCount(4)

		const before = await ownPosition(page)
		await pad.getByTestId('sh-move-right').dispatchEvent('pointerdown')
		await expect.poll(async () => (await ownPosition(page)).x).toBeGreaterThan(before.x)
		await pad.getByTestId('sh-move-right').dispatchEvent('pointerup')
		expect(errors).toEqual([])
	})

	test('movement propagates to another realtime identity', async ({ browser }) => {
		const contextA = await browser.newContext()
		const contextB = await browser.newContext()
		const a = await contextA.newPage()
		const b = await contextB.newPage()
		try {
			await Promise.all([openShooter(a), openShooter(b)])
			const ownA = await ownPosition(a)
			const remoteA = await closestRemote(b, ownA)
			expect(remoteA).toBeTruthy()
			const remote = remoteByKey(b, remoteA?.key ?? '')
			await holdKey(a, 'ArrowRight', 600)
			await expect.poll(async () => Number(await remote.getAttribute('cx')), { timeout: 10_000 })
				.toBeGreaterThan(remoteA?.x ?? ownA.x)
		} finally {
			await Promise.allSettled([contextA.close(), contextB.close()])
		}
	})

	test('aimed shots register both authoritative score and server hit events', async ({ page }) => {
		await openShooter(page)
		for (let attempt = 0; attempt < 24; attempt++) {
			await shootRenderedTarget(page)
			await page.waitForTimeout(200)
			const stats = await shooterStats(page)
			if (stats.score > 0 && stats.hits > 0) break
		}
		await expect.poll(async () => {
			const stats = await shooterStats(page)
			return Math.min(stats.score, stats.hits)
		}, { message: 'rendered target hits must credit score and emit a server hit event', timeout: 5_000 })
			.toBeGreaterThanOrEqual(1)
		await expect(page.getByTestId('sh-last-hit')).toBeVisible()
	})

	test('Enter fires when nothing owns it, and a focused link keeps its own Enter', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)

		// Enter with nothing focused is a fire path, which is the keyboard gap
		// this page was changed to close.
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
		})
		await page.keyboard.press('Enter')
		await expect.poll(async () => (await shooterStats(page)).shots).toBe(1)

		// Enter with a link focused belongs to the link. Consuming it here made
		// every link in the page and its surrounding layout inoperable by
		// keyboard - the same WCAG 2.1.1 failure the fire path was added to fix,
		// moved somewhere else. Navigation is the only honest proof, since a
		// handler that fires AND calls preventDefault leaves the shot counter
		// looking perfectly healthy.
		const home = page.locator('a.demos-home-link')
		await home.focus()
		await expect(home).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(page).toHaveURL(/\/$/)
		expect(errors).toEqual([])
	})

	test('the arena card wraps its content instead of stretching to the taller column', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 })
		const errors = collectShooterErrors(page)
		await openShooter(page)

		// A stretched card takes the grid row's height, and the row is as tall as
		// its tallest item - so a stretched arena card measures EXACTLY the side
		// column's height, and a wrapped one measures less. That equality is the
		// discriminator, and it needs no tolerance.
		//
		// Note what cannot be used here: the card's height against its own
		// card-body's. daisyUI gives card-body flex-grow, so the body stretches
		// with the card and those two are equal either way - an assertion that
		// looks like a measurement and can never fail.
		const geometry = await page.getByTestId('sh-arena-card').evaluate((card) => {
			const grid = card.parentElement
			const side = grid?.querySelector('[data-testid="sh-side-column"]')
			return {
				columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
				cardHeight: card.getBoundingClientRect().height,
				sideHeight: side?.getBoundingClientRect().height ?? 0
			}
		})

		// A stacked layout has no taller sibling to stretch to, so the band could
		// not exist and the comparison below would prove nothing.
		expect(geometry.columns, 'the two-column layout did not engage at 1440px').toBe(2)
		expect(geometry.cardHeight).toBeGreaterThan(0)
		expect(geometry.sideHeight).toBeGreaterThan(0)
		expect(
			geometry.cardHeight,
			`arena card is ${Math.round(geometry.cardHeight)}px beside a ${Math.round(geometry.sideHeight)}px column - matching it means the card took the row's height instead of wrapping its content, and the surplus is dead space under the caption`
		).toBeLessThan(geometry.sideHeight)
		expect(errors).toEqual([])
	})

	test('a lagged click is acknowledged at once, at the point it was clicked', async ({ page }) => {
		const errors = collectShooterErrors(page)
		await openShooter(page)

		const slider = page.getByTestId('sh-lag')
		await slider.fill('400')
		await expect(page.getByRole('heading', { name: 'Extra latency: 400ms' })).toBeVisible()
		await slider.blur()

		// Far from the player dot, so a receipt drawn at the shooter instead of
		// at the click could not pass the distance check below.
		const aimX = 120
		const aimY = 90
		await clickRangeAt(page, aimX, aimY)

		const ring = page.getByTestId('sh-click-ring').first()
		await expect(ring).toBeVisible()
		const at = await ring.evaluate((node) => ({
			x: Number(node.getAttribute('cx')),
			y: Number(node.getAttribute('cy'))
		}))
		// The receipt is on screen while the shot is still inside its send
		// delay. That window is the whole finding: 400ms of silence on the
		// reported path is what trains a visitor to click again.
		expect((await shooterStats(page)).shots).toBe(0)
		expect(
			Math.hypot(at.x - aimX, at.y - aimY),
			`receipt drawn at ${at.x},${at.y} for a click at ${aimX},${aimY}`
		).toBeLessThanOrEqual(4)

		await expect.poll(async () => (await shooterStats(page)).shots).toBe(1)
		expect(errors).toEqual([])
	})

	test('being shot narrates itself to the victim, through damage and respawn', async ({ browser }) => {
		test.setTimeout(120_000)
		const contextA = await browser.newContext()
		const contextB = await browser.newContext()
		const a = await contextA.newPage()
		const b = await contextB.newPage()
		try {
			await Promise.all([openShooter(a), openShooter(b)])
			const hpOf = async (page) => Number(
				(await page.getByTestId('sh-hp').textContent())?.match(/\d+/)?.[0] ?? 0
			)
			const scoreOf = async (page) => (await shooterStats(page)).score
			const scoreBefore = await scoreOf(a)

			// Aim at where B says it is. Both pages render the same world
			// coordinates, so B's own dot is the aim point; the ray stops on the
			// first body, so an NPC drifting across the line costs an attempt
			// rather than the test.
			const transitions = []
			let previous = await hpOf(b)
			for (let attempt = 0; attempt < 80 && transitions.length < 3; attempt++) {
				const victim = await ownPosition(b)
				await clickRangeAt(a, victim.x, victim.y)
				await a.waitForTimeout(120)
				const now = await hpOf(b)
				if (now !== previous) {
					transitions.push([previous, now])
					previous = now
				}
			}

			// The victim's own reading of the damage, in order, including the
			// respawn that restores it. An existence check on "hp: <digit>"
			// passes with hp hard-coded, or frozen, or never wired to the wire.
			expect(transitions, 'the victim never saw its own hp move').toEqual([[3, 2], [2, 1], [1, 3]])
			// ...and it was these shots that did it.
			expect(await scoreOf(a) - scoreBefore).toBeGreaterThanOrEqual(3)
		} finally {
			await Promise.allSettled([contextA.close(), contextB.close()])
		}
	})
})
