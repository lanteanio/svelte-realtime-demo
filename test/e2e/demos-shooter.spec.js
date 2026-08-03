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
		// The slider runs PAST maxRewindMs on purpose: the band beyond the
		// marked cap is where aimed shots start missing, which is the only
		// way the cap is experienceable rather than prose.
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
})
