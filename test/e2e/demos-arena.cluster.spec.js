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

// The page draws your dot at the client's initializer, the centre of the
// world, until the server's join reply moves it to your spawn, so leaving the
// centre is what proves this visitor has joined.
async function openJoined(page, origin) {
	await openAt(page, origin)
	let spot
	await expect.poll(async () => {
		const me = page.getByTestId('arena-me')
		spot = { x: Number(await me.getAttribute('data-x')), y: Number(await me.getAttribute('data-y')) }
		return spot.x !== 1200 || spot.y !== 800
	}, { message: 'own dot never left the pre-join centre, so the join reply never arrived', timeout: 15_000 }).toBe(true)
	return spot
}

async function camera(page) {
	const text = (await page.getByTestId('arena-cam').textContent()) ?? ''
	const match = text.match(/cam\s+(-?\d+),\s*(-?\d+)/)
	return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: Number.NaN, y: Number.NaN }
}

// Pan the spectate camera until it sits within half a pan step of `spot`.
async function panCameraTo(page, spot) {
	for (let i = 0; i < 40; i++) {
		const cam = await camera(page)
		if (Math.abs(cam.x - spot.x) > 80) await page.getByTestId(cam.x < spot.x ? 'arena-pan-right' : 'arena-pan-left').click()
		else if (Math.abs(cam.y - spot.y) > 80) await page.getByTestId(cam.y < spot.y ? 'arena-pan-down' : 'arena-pan-up').click()
		else return
	}
	throw new Error(`camera never reached ${spot.x}, ${spot.y}`)
}

function visitorsReceived(page) {
	return page.locator('[data-testid="arena-minimap-entity"][data-kind="visitor"]').count()
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

	// Which replica ticks the world is decided by whoever reached it first, so
	// both join orders run: one of them always puts the earlier visitor on a
	// replica that does not tick. The camera is panned onto the later visitor
	// because the 420-unit interest circle rarely covers two random spawns in a
	// 2400x1600 world.
	test('a visitor who joins later and stands still appears once the camera reaches them', async ({ browser }) => {
		test.setTimeout(60_000)
		for (const [first, second] of [[INSTANCE_A, INSTANCE_B], [INSTANCE_B, INSTANCE_A]]) {
			const ctxEarly = await browser.newContext({ baseURL: first })
			const ctxLate = await browser.newContext({ baseURL: second })
			try {
				const early = await ctxEarly.newPage()
				await openJoined(early, first)
				const late = await ctxLate.newPage()
				const lateSpot = await openJoined(late, second)
				await early.getByTestId('arena-spectate-toggle').check()
				await panCameraTo(early, lateSpot)
				// No key is pressed on the late page: it has to be received for
				// having joined, not for having moved.
				await expect.poll(() => visitorsReceived(early), {
					message: `the visitor who joined later on ${second} must reach ${first} without moving first`,
					timeout: 10_000
				}).toBe(1)
			} finally {
				await Promise.allSettled([ctxEarly.close(), ctxLate.close()])
			}
		}
	})

	// The interest circle covers roughly a seventh of the world, so a visitor
	// who has joined should be receiving a few dozen entities at most, on
	// whichever replica the connection landed. One visitor opens on each
	// replica, so one of them always joins a replica that does not tick.
	test('a visitor joining either replica receives a culled world, not the whole of it', async ({ browser }) => {
		test.setTimeout(60_000)
		for (const origin of [INSTANCE_A, INSTANCE_B]) {
			const ctx = await browser.newContext({ baseURL: origin })
			const page = await ctx.newPage()
			try {
				await openAt(page, origin)
				// Zero is what the HUD reads before any data arrives, and it is
				// below every bar, so the join has to be seen first.
				await expect.poll(async () => (await hud(page)).receiving, { timeout: 15_000 }).toBeGreaterThan(0)
				await expect.poll(async () => (await hud(page)).receiving, {
					message: `a visitor who joined on ${origin} must be sent what its interest circle covers, not the world`,
					timeout: 15_000
				}).toBeLessThan(75)
			} finally {
				await ctx.close()
			}
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
