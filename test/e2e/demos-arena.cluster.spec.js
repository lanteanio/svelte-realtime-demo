import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'arena cluster coverage requires two explicit replica targets')

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/arena`)
	await waitForWS(page)
	await expect(page.getByTestId('arena-me')).toBeVisible({ timeout: 15_000 })
}

async function hud(page) {
	const text = (await page.getByTestId('arena-hud').textContent()) ?? ''
	const match = text.match(/receiving\s+(\d+)\s+of\s+(\d+)/)
	// NaN, not -1, on a parse miss. Every comparison against NaN is false, so a
	// HUD that stops rendering fails the assertion instead of sliding under a
	// `toBeLessThan` threshold and reporting green.
	return match
		? { receiving: Number(match[1]), total: Number(match[2]) }
		: { receiving: Number.NaN, total: Number.NaN }
}

async function x(page) {
	return Number(await page.getByTestId('arena-me').getAttribute('data-x'))
}

test.describe('cluster: /demos/arena', () => {
	test('replicas share the authoritative world while each player command remains independently predicted', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			// Poll like the denominator test below: the interest snapshot
			// arrives via the smooth sync after the page settles, so a single
			// read straight after open races the relay on a fresh replica.
			for (const page of [a, b]) {
				await expect.poll(async () => (await hud(page)).receiving, { timeout: 15_000 }).toBeGreaterThan(0)
			}
			const beforeA = await x(a)
			const beforeB = await x(b)
			await a.keyboard.down('ArrowRight')
			await a.waitForTimeout(600)
			await a.keyboard.up('ArrowRight')
			await expect.poll(() => x(a)).toBeGreaterThan(beforeA)
			expect(await x(b)).toBe(beforeB)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('every replica reports the authoritative 150-entity HUD denominator', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			for (const page of [a, b]) {
				await expect.poll(async () => (await hud(page)).total, {
					message: 'non-authority replicas must not report total 0',
					timeout: 15_000
				}).toBeGreaterThanOrEqual(150)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('relayed interest culling releases traversed entities after cross-world panning', async ({ browser }) => {
		test.setTimeout(45_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await b.getByTestId('arena-spectate-toggle').click()
			// Witness the included side before asserting the exclusion. The world
			// holds 150 NPCs over 2400x1600 while the 420-unit interest circle
			// covers ~14% of it, so `receiving` sits near 20 from the start and a
			// fixed `< 60` bar was already satisfied before any panning happened:
			// a pan control that silently no-opped would still have passed. Take a
			// measured baseline from the centre instead, and require a real drop
			// away from it.
			await expect.poll(async () => (await hud(b)).total, { timeout: 15_000 }).toBeGreaterThanOrEqual(150)
			const centred = await hud(b)
			expect(centred.receiving).toBeGreaterThan(0)
			for (let i = 0; i < 60; i++) {
				await b.getByTestId('arena-pan-right').click()
				await b.getByTestId('arena-pan-down').click()
			}
			// Panning to a corner leaves most of the interest circle outside the
			// world, so the relayed set must shrink against the centred baseline.
			await expect.poll(async () => (await hud(b)).receiving, {
				message: 'relayed received set must shrink after panning to a corner',
				timeout: 12_000
			}).toBeLessThan(centred.receiving)
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
