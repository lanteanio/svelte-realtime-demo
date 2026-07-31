import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import {
	dlqState,
	expectDlqConsistent,
	handlerKinds,
	integer,
	openOps,
	replicaId,
	topicTotal
} from './ops-helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')
const DISTINCT_TARGETS = new URL(INSTANCE_A).origin !== new URL(INSTANCE_B).origin
const ORDERS_TOPIC = 'demos:outbound:orders'

test.skip(!process.env.INSTANCE_B, 'ops cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openPair(browser) {
	const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
	const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
	const a = await ctxA.newPage()
	const b = await ctxB.newPage()
	await Promise.all([
		openOps(a, `${INSTANCE_A}/demos/ops`),
		openOps(b, `${INSTANCE_B}/demos/ops`)
	])
	return { ctxA, ctxB, a, b }
}

test.describe('cluster: /demos/ops', () => {
	test('local introspection is replica-attributed while handler shape and Redis DLQ agree', async ({ browser }) => {
		const pair = await openPair(browser)
		try {
			const [replicaA, replicaB] = await Promise.all([replicaId(pair.a), replicaId(pair.b)])
			if (DISTINCT_TARGETS) expect(replicaA).not.toBe(replicaB)
			for (const page of [pair.a, pair.b]) {
				expect(await integer(page, 'ops-connections')).toBeGreaterThanOrEqual(1)
				await expect(page.getByTestId('ops-replica-note')).toContainText("one worker's local counts")
			}
			expect(await integer(pair.a, 'ops-handlers-total')).toBe(await integer(pair.b, 'ops-handlers-total'))
			// Per-kind counts are NOT equal across replicas by construction: a
			// handler reports 'lazy' until its module first loads on that
			// worker, and traffic skew resolves the pools unevenly. The real
			// shared-registry invariant is: same total (above), same kind
			// vocabulary, and every kind's cross-replica shortfall covered by
			// the other replica's unresolved lazy pool - a replica exposing a
			// handler the other could never resolve to still fails.
			const kindsA = await handlerKinds(pair.a)
			const kindsB = await handlerKinds(pair.b)
			expect(Object.keys(kindsA).sort()).toEqual(Object.keys(kindsB).sort())
			for (const kind of Object.keys(kindsA)) {
				if (kind === 'lazy') continue
				expect(kindsA[kind], `${kind} beyond B's lazy slack`).toBeLessThanOrEqual(kindsB[kind] + (kindsB.lazy ?? 0))
				expect(kindsB[kind], `${kind} beyond A's lazy slack`).toBeLessThanOrEqual(kindsA[kind] + (kindsA.lazy ?? 0))
			}
			expect(await expectDlqConsistent(pair.a)).toEqual(await expectDlqConsistent(pair.b))
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})

	test('a dead letter created through replica A appears in replica B Ops and converges after navigation back', async ({ browser }) => {
		test.setTimeout(45_000)
		const pair = await openPair(browser)
		try {
			const baseline = await dlqState(pair.b)
			await pair.a.getByTestId('ops-dlq-card').getByRole('link', { name: '/demos/outbound-webhooks' }).click()
			await expect(pair.a).toHaveURL(/\/demos\/outbound-webhooks$/)
			await pair.a.getByTestId('ow-place-fail').click()
			await expect(pair.a.getByTestId('ow-last-order')).toBeVisible()
			const shortId = (await pair.a.getByTestId('ow-last-order').textContent())?.match(/placed\s+(\w{8})/)?.[1]
			expect(shortId).toBeTruthy()
			await expect(pair.a.getByTestId('ow-dlq-row').filter({ hasText: shortId ?? '' }).first())
				.toBeVisible({ timeout: 25_000 })

			await expect.poll(async () => (await dlqState(pair.b)).total, { timeout: 15_000 })
				.toBeGreaterThan(baseline.total)
			const remote = await dlqState(pair.b)
			expect(topicTotal(remote, ORDERS_TOPIC)).toBeGreaterThan(topicTotal(baseline, ORDERS_TOPIC))

			await pair.a.getByRole('link', { name: '/demos/ops' }).click()
			await expect(pair.a).toHaveURL(/\/demos\/ops$/)
			await openOps(pair.a, `${INSTANCE_A}/demos/ops`)
			await expect.poll(async () => (await dlqState(pair.a)).total, { timeout: 10_000 }).toBe(remote.total)
			expect(await dlqState(pair.a)).toEqual(await dlqState(pair.b))
		} finally {
			await Promise.allSettled([pair.ctxA.close(), pair.ctxB.close()])
		}
	})
})
