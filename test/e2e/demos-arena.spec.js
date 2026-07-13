import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/arena', () => {
	function collectErrors(page) {
		const errors = []
		page.on('pageerror', (err) => errors.push(`pageerror: ${err?.message ?? err}`))
		page.on('console', (msg) => {
			// Resource-load noise (favicons, aborted fetches on teardown) is
			// not an app error; uncaught exceptions and app console.error are.
			if (msg.type() === 'error' && !/Failed to load resource|favicon/i.test(msg.text())) {
				errors.push(`console: ${msg.text()}`)
			}
		})
		return errors
	}

	async function openArena(page) {
		await page.goto('/demos/arena')
		await waitForWS(page)
	}

	test('interest cull settles bounded after panning across the world', async ({ page }) => {
		// Pan the interest center across the 2400x1600 world in spectate mode,
		// then let it settle. The received set may spike transiently during rapid
		// movement (stale entities briefly outrun the TTL sweep), but once panning
		// stops it must settle back near the radius-420 subset, not stay pinned at
		// the whole traversed population. Guards the cull's release path (a hard
		// "never released" leak would leave this near 150).
		await openArena(page)
		await expect(page.getByTestId('arena-me')).toBeVisible({ timeout: 15_000 })
		const receiving = async () => {
			const t = (await page.getByTestId('arena-hud').textContent()) ?? ''
			const m = t.match(/receiving\s+(\d+)\s+of\s+(\d+)/)
			return m ? Number(m[1]) : -1
		}
		await page.waitForTimeout(3000)
		await page.getByTestId('arena-spectate-toggle').click()
		for (let i = 0; i < 60; i++) {
			await page.getByTestId('arena-pan-right').click()
			await page.getByTestId('arena-pan-down').click()
		}
		// Poll while the sweep catches up; the received set must fall back well
		// below the full population once movement stops.
		await expect
			.poll(() => receiving(), { message: 'received set should settle after panning', timeout: 12_000 })
			.toBeLessThan(60)
	})

	test('own dot renders and the HUD counts culled remote entities', async ({ page }) => {
		const errors = collectErrors(page)
		await openArena(page)

		await expect(page.getByTestId('arena-me')).toBeVisible({ timeout: 15_000 })

		// 150 server-driven NPCs guarantee population inside the interest
		// radius; the HUD's receiving count comes from view.remote.size.
		await expect
			.poll(async () => {
				const text = await page.getByTestId('arena-hud').textContent()
				const m = text?.match(/receiving (\d+) of (\d+)/)
				return m ? Number(m[1]) : -1
			}, { timeout: 15_000 })
			.toBeGreaterThan(0)
		await expect(page.getByTestId('arena-hud')).toContainText('% culled')

		// The denominator (server catalog) must exceed what one client
		// receives - that difference IS the cull. The catalog size is a 2s
		// poll (`population`), and its first sample can land before the tick
		// this client's own subscribe arms has populated the roster, so wait
		// for the denominator to settle rather than sampling once.
		await expect
			.poll(async () => {
				const text = await page.getByTestId('arena-hud').textContent()
				const m = text?.match(/receiving (\d+) of (\d+)/)
				return m ? Number(m[2]) - Number(m[1]) : -1
			}, { timeout: 15_000 })
			.toBeGreaterThan(0)

		expect(errors).toEqual([])
	})

	test('arrow key moves the predicted own dot', async ({ page }) => {
		const errors = collectErrors(page)
		await openArena(page)

		const me = page.getByTestId('arena-me')
		await expect(me).toBeVisible({ timeout: 15_000 })

		// Let the first sync land so the dot sits at its authoritative
		// spawn before we measure (the pre-sync placeholder would move too,
		// but measuring across the snap would be noisy).
		await page.waitForTimeout(1_000)

		const beforeX = Number(await me.getAttribute('data-x'))
		expect(Number.isFinite(beforeX)).toBe(true)

		await page.keyboard.down('ArrowRight')
		await page.waitForTimeout(700)
		await page.keyboard.up('ArrowRight')

		await expect
			.poll(async () => Number(await me.getAttribute('data-x')), { timeout: 5_000 })
			.toBeGreaterThan(beforeX)

		expect(errors).toEqual([])
	})

	test('spectate mode pans the reported area-of-interest center', async ({ page }) => {
		await openArena(page)
		await expect(page.getByTestId('arena-me')).toBeVisible({ timeout: 15_000 })

		await page.getByTestId('arena-spectate-toggle').click()
		const cam = page.getByTestId('arena-cam')
		await expect(cam).toBeVisible()

		const before = await cam.textContent()
		await page.getByTestId('arena-pan-right').click()
		await page.getByTestId('arena-pan-right').click()
		await expect(cam).not.toHaveText(before ?? '')

		// Toggling back reverts culling to the own-entity center.
		await page.getByTestId('arena-spectate-toggle').click()
		await expect(cam).not.toBeVisible()
	})
})
