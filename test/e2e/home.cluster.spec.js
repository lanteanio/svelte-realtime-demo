import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	DEMO_SLUGS,
	createBoardFromHome,
	demoTile,
	expectBoardCard,
	expectBoardPresence,
	navigateHome,
	navbarIdentity,
	openHome
} from './home-helpers.js'
import { waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'home cluster coverage requires two explicit replica targets')

test.describe('cluster: home + gallery', () => {
	test('board creation, cards, exact presence cleanup, identities, and gallery inventory converge both ways', async ({ browser }) => {
		test.setTimeout(120_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const ctxObserverA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxObserverB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		const observerA = await ctxObserverA.newPage()
		const observerB = await ctxObserverB.newPage()
		try {
			await Promise.all([
				openHome(a, INSTANCE_A),
				openHome(b, INSTANCE_B),
				openHome(observerA, INSTANCE_A),
				openHome(observerB, INSTANCE_B)
			])
			const identities = await Promise.all([a, b, observerA, observerB].map(navbarIdentity))
			expect(new Set(identities.map((entry) => entry.token)).size).toBe(4)
			for (const page of [observerA, observerB]) {
				await expect(page.getByTestId('demos-list').locator('a')).toHaveCount(DEMO_SLUGS.length)
				await expect(demoTile(page, 'phases')).toHaveAttribute('href', '/demos/phases')
			}

			const titleA = `Cluster home A ${Date.now()}`
			const pathA = await createBoardFromHome(a, titleA)
			await Promise.all([expectBoardCard(observerA, pathA, titleA), expectBoardCard(observerB, pathA, titleA)])
			await Promise.all([expectBoardPresence(observerA, pathA, 1), expectBoardPresence(observerB, pathA, 1)])

			await b.goto(`${INSTANCE_B}${pathA}`)
			await waitForWS(b)
			await Promise.all([expectBoardPresence(observerA, pathA, 2), expectBoardPresence(observerB, pathA, 2)])
			await navigateHome(b)
			await Promise.all([expectBoardPresence(observerA, pathA, 1), expectBoardPresence(observerB, pathA, 1)])
			await navigateHome(a)
			await Promise.all([expectBoardPresence(observerA, pathA, 0), expectBoardPresence(observerB, pathA, 0)])

			const titleB = `Cluster home B ${Date.now()}`
			const pathB = await createBoardFromHome(b, titleB, 'enter')
			await Promise.all([expectBoardCard(observerA, pathB, titleB), expectBoardCard(observerB, pathB, titleB)])
			await Promise.all([expectBoardPresence(observerA, pathB, 1), expectBoardPresence(observerB, pathB, 1)])
			await navigateHome(b)
			await Promise.all([expectBoardPresence(observerA, pathB, 0), expectBoardPresence(observerB, pathB, 0)])
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close(), ctxObserverA.close(), ctxObserverB.close()])
		}
	})
})
