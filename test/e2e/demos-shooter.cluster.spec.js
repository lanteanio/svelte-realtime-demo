import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	clickRangeAt,
	closestRemote,
	holdKey,
	joinedPosition,
	openShooter,
	ownPosition,
	remoteByKey,
	remotesAt,
	shooterStats
} from './shooter-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'shooter cluster coverage requires two explicit replica targets')

async function openPair(browser) {
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	await Promise.all([
		openShooter(a, `${INSTANCE_A}/demos/shooter`),
		openShooter(b, `${INSTANCE_B}/demos/shooter`)
	])
	return { ctxA, ctxB, a, b }
}

test.describe('cluster: /demos/shooter', () => {
	test('replica B renders movement predicted and reconciled on replica A', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			const ownA = await ownPosition(pair.a)
			const remoteA = await closestRemote(pair.b, ownA)
			expect(remoteA).toBeTruthy()
			const remote = remoteByKey(pair.b, remoteA?.key ?? '')
			await holdKey(pair.a, 'd', 600)
			await expect.poll(async () => Number(await remote.getAttribute('cx')), { timeout: 10_000 })
				.toBeGreaterThan(remoteA?.x ?? ownA.x)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	// Which replica ticks the range is decided by whoever reached it first, and
	// it stays there while the targets exist, so the test cannot know it in
	// advance. Running both join orders guarantees one of them puts the earlier
	// visitor on a replica that does not tick - the side that learns about other
	// players only from what the ticking replica sends it.
	test('a visitor who joins later and stands still appears on both replicas', async ({ browser }) => {
		for (const [first, second] of [[INSTANCE_A, INSTANCE_B], [INSTANCE_B, INSTANCE_A]]) {
			const ctxEarly = await browser.newContext({ baseURL: first })
			const ctxLate = await browser.newContext({ baseURL: second })
			try {
				const early = await ctxEarly.newPage()
				await openShooter(early, `${first}/demos/shooter`)
				const earlySpot = await joinedPosition(early)
				const late = await ctxLate.newPage()
				await openShooter(late, `${second}/demos/shooter`)
				const lateSpot = await joinedPosition(late)
				// No key is pressed on either page: the late visitor has to be
				// visible for having joined, not for having moved.
				await expect.poll(() => remotesAt(late, earlySpot), {
					message: `the visitor who joined on ${first} must render on ${second}`,
					timeout: 10_000
				}).toBe(1)
				await expect.poll(() => remotesAt(early, lateSpot), {
					message: `the visitor who joined later on ${second} must render on ${first} without moving first`,
					timeout: 10_000
				}).toBe(1)
			} finally {
				await Promise.allSettled([ctxEarly.close(), ctxLate.close()])
			}
		}
	})

	test('a rendered player hit across replicas credits the shooter and emits a hit event', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			const ownA = await ownPosition(pair.a)
			const target = await closestRemote(pair.b, ownA)
			expect(target).toBeTruthy()
			for (let attempt = 0; attempt < 20; attempt++) {
				const circle = remoteByKey(pair.b, target?.key ?? '')
				const x = Number(await circle.getAttribute('cx'))
				const y = Number(await circle.getAttribute('cy'))
				await clickRangeAt(pair.b, x, y)
				await pair.b.waitForTimeout(200)
				const stats = await shooterStats(pair.b)
				if (stats.score > 0 && stats.hits > 0) break
			}
			await expect.poll(async () => {
				const stats = await shooterStats(pair.b)
				return Math.min(stats.score, stats.hits)
			}, { message: 'cross-replica hit must credit score and emit a server event', timeout: 5_000 })
				.toBeGreaterThanOrEqual(1)
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})
})
