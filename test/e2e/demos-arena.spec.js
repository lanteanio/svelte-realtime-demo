import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

function collectErrors(page) {
	const errors = []
	page.on('pageerror', (err) => errors.push(`pageerror: ${err?.message ?? err}`))
	page.on('console', (msg) => {
		if (msg.type() === 'error' && !/Failed to load resource|favicon/i.test(msg.text())) errors.push(`console: ${msg.text()}`)
	})
	return errors
}

async function open(page) {
	await page.goto('/demos/arena')
	await waitForWS(page)
	await expect(page.getByTestId('arena-me')).toBeVisible({ timeout: 15_000 })
}

async function hud(page) {
	const text = (await page.getByTestId('arena-hud').textContent()) ?? ''
	const match = text.match(/receiving\s+(\d+)\s+of\s+(\d+)\s+entities\s+\((\d+)% culled\)/)
	return match
		? { receiving: Number(match[1]), total: Number(match[2]), culled: Number(match[3]) }
		: { receiving: -1, total: -1, culled: -1 }
}

async function position(page) {
	const me = page.getByTestId('arena-me')
	return { x: Number(await me.getAttribute('data-x')), y: Number(await me.getAttribute('data-y')) }
}

async function hold(page, key, ms = 500) {
	await page.keyboard.down(key)
	await page.waitForTimeout(ms)
	await page.keyboard.up(key)
}

async function camera(page) {
	const text = (await page.getByTestId('arena-cam').textContent()) ?? ''
	const match = text.match(/cam\s+(\d+),\s+(\d+)/)
	return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: NaN, y: NaN }
}

test.describe('/demos/arena', () => {
	test('renders the complete world, own/remote entities, honest HUD math, legend, and controls without errors', async ({ page }) => {
		const errors = collectErrors(page)
		await open(page)
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Arena: area-of-interest culling')
		const viewport = page.getByTestId('arena-viewport')
		await expect(viewport).toBeVisible()
		await expect(page.getByTestId('arena-fringe-ring')).toHaveAttribute('r', '300')
		await expect(page.getByTestId('arena-fringe-ring')).toHaveAttribute('stroke-dasharray', '8 7')
		await expect(page.getByTestId('arena-cull-ring')).toHaveAttribute('r', '420')
		expect(await viewport.evaluate((svg) => {
			const box = svg.viewBox.baseVal
			const ring = svg.querySelector('[data-testid="arena-cull-ring"]')
			return {
				viewBox: [box.width, box.height],
				leftArc: Number(ring.getAttribute('cx')) - Number(ring.getAttribute('r')),
				rightArc: Number(ring.getAttribute('cx')) + Number(ring.getAttribute('r'))
			}
		})).toEqual({ viewBox: [900, 600], leftArc: 30, rightArc: 870 })
		await expect(page.getByTestId('arena-radius-legend')).toContainText('fringe starts at 300')
		await expect(page.getByTestId('arena-radius-legend')).toContainText('delivery stops at 420')
		// The three fill colors name themselves; the stale swatch keeps a
		// full-opacity border so it survives the dark theme.
		await expect(page.getByTestId('arena-kind-legend')).toContainText('you')
		await expect(page.getByTestId('arena-kind-legend')).toContainText('NPC')
		await expect(page.getByTestId('arena-kind-legend')).toContainText('another visitor')
		await expect(page.getByTestId('arena-stale-swatch')).toHaveClass(/border/)
		// The world has texture and an overview: 300-unit grid lines plus
		// a minimap with the camera window and the received set.
		expect(await page.getByTestId('arena-grid-line').count()).toBe(12)
		await expect(page.getByTestId('arena-minimap')).toBeVisible()
		await expect(page.getByTestId('arena-minimap-view')).toBeVisible()
		await expect(page.getByTestId('arena-minimap-me')).toBeVisible()
		await expect(page.getByTestId('arena-radius-note')).toContainText('beyond its top and bottom edges')
		await expect(page.getByTestId('arena-remote').first()).toBeVisible()
		await expect.poll(async () => (await hud(page)).total, { timeout: 15_000 }).toBeGreaterThanOrEqual(150)
		const values = await hud(page)
		expect(values.receiving).toBeGreaterThan(0)
		expect(values.receiving).toBeLessThan(values.total)
		expect(values.culled).toBeGreaterThan(0)
		expect(values.culled).toBeLessThanOrEqual(100)
		await expect(page.getByText('WASD / arrows to move', { exact: true })).toBeVisible()
		await expect(page.getByTestId('arena-spectate-toggle')).not.toBeChecked()
		await expect(page.getByTestId('arena-error')).toHaveCount(0)
		expect(errors).toEqual([])
	})

	test('WASD and arrow aliases move the predicted own dot in all four directions', async ({ page }) => {
		const errors = collectErrors(page)
		await open(page)
		await page.waitForTimeout(1_000)
		let before = await position(page)
		await hold(page, 'd')
		await expect.poll(async () => (await position(page)).x).toBeGreaterThan(before.x)
		before = await position(page)
		await hold(page, 'ArrowDown')
		await expect.poll(async () => (await position(page)).y).toBeGreaterThan(before.y)
		before = await position(page)
		await hold(page, 'a')
		await expect.poll(async () => (await position(page)).x).toBeLessThan(before.x)
		before = await position(page)
		await hold(page, 'ArrowUp')
		await expect.poll(async () => (await position(page)).y).toBeLessThan(before.y)
		expect(errors).toEqual([])
	})

	test('phone visitors get 44px touch controls that move the predicted player', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await open(page)
		const pad = page.getByTestId('arena-move-pad')
		await expect(pad).toBeVisible()
		const controls = pad.getByRole('button')
		await expect(controls).toHaveCount(4)
		for (const control of await controls.all()) {
			const box = await control.boundingBox()
			expect(box.width).toBeGreaterThanOrEqual(44)
			expect(box.height).toBeGreaterThanOrEqual(44)
		}

		// Selecting by accessible name proves the handlers are wired but says
		// nothing about where the buttons actually SIT. Grid auto-placement had
		// them rendering as a scrambled cross - left drawn where right belongs -
		// and a name-only test passed straight through it. Assert the geometry.
		const boxes = {}
		for (const dir of ['up', 'left', 'down', 'right']) {
			boxes[dir] = await pad.getByTestId(`arena-move-${dir}`).boundingBox()
		}
		expect(boxes.left.x).toBeLessThan(boxes.up.x)
		expect(boxes.up.x).toBeLessThan(boxes.right.x)
		expect(Math.round(boxes.down.x)).toBe(Math.round(boxes.up.x))
		expect(boxes.up.y).toBeLessThan(boxes.down.y)
		expect(Math.round(boxes.left.y)).toBe(Math.round(boxes.down.y))
		expect(Math.round(boxes.right.y)).toBe(Math.round(boxes.down.y))

		// Press and hold: the pad feeds the same held-key set the keyboard does,
		// so movement continues while held rather than stepping once per tap.
		let before = await position(page)
		await pad.getByTestId('arena-move-right').dispatchEvent('pointerdown')
		await expect.poll(async () => (await position(page)).x).toBeGreaterThan(before.x)
		await pad.getByTestId('arena-move-right').dispatchEvent('pointerup')
		before = await position(page)
		await pad.getByTestId('arena-move-up').dispatchEvent('pointerdown')
		await expect.poll(async () => (await position(page)).y).toBeLessThan(before.y)
		await pad.getByTestId('arena-move-up').dispatchEvent('pointerup')
		// Releasing stops movement: the held set must not latch. Commands
		// already in flight (and the server reconcile of the predicted dot)
		// may nudge the position for a moment after pointerup, so wait for
		// two consecutive samples 300ms apart to agree - a latched key keeps
		// moving at ~180 units/sec and can never satisfy that, so the poll
		// times out instead of a single too-early sample passing or failing
		// on the reconcile tail.
		await expect.poll(async () => {
			const a = (await position(page)).y
			await page.waitForTimeout(300)
			return (await position(page)).y - a
		}, { timeout: 10_000 }).toBe(0)
	})

	test('Spectate exposes all pan controls with clamped 160-unit steps and suppresses player movement', async ({ page }) => {
		await open(page)
		await page.getByTestId('arena-spectate-toggle').click()
		await expect(page.getByTestId('arena-spectate-toggle')).toBeChecked()
		const start = await camera(page)
		await page.getByTestId('arena-pan-right').click()
		let current = await camera(page)
		expect(current.x).toBe(Math.min(2400, start.x + 160))
		await page.getByTestId('arena-pan-down').click()
		const afterDown = await camera(page)
		expect(afterDown.y).toBe(Math.min(1600, current.y + 160))
		await page.getByTestId('arena-pan-left').click()
		current = await camera(page)
		expect(current.x).toBe(Math.max(0, afterDown.x - 160))
		await page.getByTestId('arena-pan-up').click()
		current = await camera(page)
		expect(current.y).toBe(Math.max(0, afterDown.y - 160))

		// The pan controls are a real d-pad: up sits centered ABOVE the
		// left/down/right row, at btn-sm size, spatial mapping intact.
		const box = async (id) => await page.getByTestId(id).boundingBox()
		const [up, left, down, right] = await Promise.all([
			box('arena-pan-up'), box('arena-pan-left'), box('arena-pan-down'), box('arena-pan-right')
		])
		expect(up.y + up.height).toBeLessThanOrEqual(down.y + 1)
		expect(Math.abs(up.x - down.x)).toBeLessThan(2)
		expect(Math.abs(left.y - down.y)).toBeLessThan(2)
		expect(Math.abs(right.y - down.y)).toBeLessThan(2)
		expect(up.height).toBeGreaterThanOrEqual(30)

		// The keys that just moved the world do not go dead in spectate:
		// they pan the camera while the own dot stays put.
		const own = await position(page)
		const camBefore = await camera(page)
		await hold(page, 'ArrowRight')
		expect(await position(page)).toEqual(own)
		await expect.poll(async () => (await camera(page)).x).toBeGreaterThan(camBefore.x)
		await page.getByTestId('arena-spectate-toggle').click()
		await expect(page.getByTestId('arena-cam')).toHaveCount(0)
		await expect(page.getByTestId('arena-spectate-toggle')).not.toBeChecked()
	})

	test('interest cull settles bounded after panning across the world', async ({ page }) => {
		test.setTimeout(45_000)
		await open(page)
		await page.waitForTimeout(3_000)
		await page.getByTestId('arena-spectate-toggle').click()
		for (let i = 0; i < 60; i++) {
			await page.getByTestId('arena-pan-right').click()
			await page.getByTestId('arena-pan-down').click()
		}
		await expect.poll(async () => (await hud(page)).receiving, {
			message: 'received set should settle after panning',
			timeout: 12_000
		}).toBeLessThan(60)
	})
})
