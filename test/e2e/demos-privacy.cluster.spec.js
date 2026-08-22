import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { sharedIdentityState } from './helpers.js'
import {
	inStableRound,
	openPrivacy,
	protectedSnapshot,
	rawState,
	roundState,
	submitMood,
	waitForDistinct,
	waitForProtected
} from './privacy-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'privacy cluster coverage requires two explicit replica targets')

test.describe('cluster: /demos/privacy', () => {
	test('one cloned identity counts once across replicas, then two fresh identities cross k consistently', async ({ browser }) => {
		// Waiting out a round boundary can cost a minute; the below-k assertions
		// after it are the point of the test and must not be skipped to save it.
		test.setTimeout(150_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const a = await ctxA.newPage()
		await openPrivacy(a, `${INSTANCE_A}/demos/privacy`)
		const state = await sharedIdentityState(ctxA, INSTANCE_B)
		const ctxSameB = await browser.newContext({ baseURL: INSTANCE_B, storageState: state })
		const sameB = await ctxSameB.newPage()
		const ctxFreshA = await browser.newContext({ baseURL: INSTANCE_A })
		const freshA = await ctxFreshA.newPage()
		const ctxFreshB = await browser.newContext({ baseURL: INSTANCE_B })
		const freshB = await ctxFreshB.newPage()
		const contexts = [ctxA, ctxSameB, ctxFreshA, ctxFreshB]
		const pages = [a, sameB, freshA, freshB]
		try {
			await Promise.all([
				openPrivacy(sameB, `${INSTANCE_B}/demos/privacy`),
				openPrivacy(freshA, `${INSTANCE_A}/demos/privacy`),
				openPrivacy(freshB, `${INSTANCE_B}/demos/privacy`)
			])
			// Start from a round this test controls. Inheriting a round already
			// at or above k made every below-k assertion below conditional, so
			// the claim the test is named for - one identity on two replicas
			// counts once, and the protected value stays WITHHELD - could go
			// entirely unexercised while the test reported green.
			// Retried as a whole rather than asserted across a boundary. Every
			// count below is scoped to one round, and this is the longest
			// round-scoped sequence in the suite - seven submissions across two
			// replicas, each waiting on a cross-replica publish - so it is the one
			// most likely to outlive the wall-clock minute it runs in. Widening the
			// headroom only moves the odds; the boundary has to be handled, and a
			// reconfirmation later in the sequence cannot help a submission that
			// threw on the boundary before reaching it.
			//
			// The page setup stays OUTSIDE the retry deliberately: a second attempt
			// must re-submit from the SAME identities, which is what makes retrying
			// safe - they add to the new window and cannot add a distinct
			// contributor. Recreating the contexts would introduce new ones.
			await inStableRound(a, async (initialRound) => {
				expect(initialRound.distinct).toBeLessThan(initialRound.k - 1)
				const initialRaw = await rawState(a)
				const held = await protectedSnapshot(a)
				await submitMood(a, 1)
				await submitMood(sameB, 5)
				await waitForDistinct(a, initialRound.distinct + 1)
				const afterSameIdentity = await roundState(a)
				// One identity, two replicas, two submissions, exactly one contributor.
				expect(afterSameIdentity.distinct).toBe(initialRound.distinct + 1)
				expect((await rawState(a)).n).toBeGreaterThanOrEqual(initialRaw.n + 2)
				expect(afterSameIdentity.distinct).toBeLessThan(afterSameIdentity.k)
				await a.waitForTimeout(750)
				expect(await protectedSnapshot(a)).toBe(held)
				expect(await protectedSnapshot(sameB)).toBe(held)

				await submitMood(freshA, 2)
				await submitMood(freshB, 4)
				// Bring all three identities into the round together before k is
				// asserted, rather than resting on the two that submitted earlier in
				// the same window. Tolerating a rollover is no longer this block's job:
				// the sequence is retried as a whole above, so a boundary starts a new
				// attempt instead of being absorbed here.
				await submitMood(a, 3)
				await submitMood(freshA, 3)
				await submitMood(freshB, 3)
				await waitForDistinct(a, 3)
				const values = await Promise.all(pages.map((page) => waitForProtected(page)))
				expect(new Set(values).size).toBe(1)
				for (const page of pages) expect((await roundState(page)).k).toBe(3)
			})
		} finally {
			await Promise.allSettled(contexts.map((context) => context.close()))
		}
	})
})
