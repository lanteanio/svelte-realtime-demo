import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'

const RUN = `cluster-${Date.now()}`
const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'auctions cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/auctions`)
	await expect(page.getByTestId('push-ready')).toBeAttached({ timeout: 10_000 })
}

async function waitForBidder(seller) {
	await expect.poll(
		async () => (await seller.getByTestId('list-submit').textContent()) ?? '',
		{ timeout: 10_000 }
	).toMatch(/[1-9]\d* bidder/)
}

async function list(seller, item, { reserve = 15, duration = 3 } = {}) {
	await seller.getByTestId('list-item-input').fill(item)
	await seller.getByTestId('list-start-input').fill('10')
	await seller.getByTestId('list-reserve-input').fill(String(reserve))
	await seller.getByTestId('list-duration-input').fill(String(duration))
	await seller.getByTestId('list-submit').click()
}

test.describe('cluster: /demos/auctions', () => {
	test('a bid pushed from replica A to B updates both waterfalls and closes sold everywhere', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await waitForBidder(a)
			const item = `lot-${RUN}-sold`
			await list(a, item, { duration: 8 })
			const card = b.getByTestId('inbox-card').filter({ hasText: item })
			await expect(card).toBeVisible({ timeout: 8_000 })
			await card.getByTestId('inbox-card-amount').fill('42')
			await card.getByTestId('inbox-card-bid').click()
			await Promise.all([a, b].map(async (page) => {
				const active = page.getByTestId('active-card').filter({ hasText: item })
				await expect(active.getByTestId('active-card-top')).toHaveText('$42')
				await expect(active.getByTestId('active-card-bid')).toHaveCount(1)
			}))
			for (const page of [a, b]) {
				const recent = page.getByTestId('recent-item').filter({ hasText: item })
				await expect(recent.getByTestId('recent-status')).toHaveText('sold', { timeout: 15_000 })
				await expect(recent.getByTestId('recent-price')).toHaveText('$42')
			}
			await expect(card.getByTestId('inbox-card-outcome')).toContainText('You won')
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('a pass returned from replica B settles no-sale on both replicas', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await waitForBidder(a)
			const item = `lot-${RUN}-pass`
			await list(a, item)
			const card = b.getByTestId('inbox-card').filter({ hasText: item })
			await expect(card).toBeVisible({ timeout: 8_000 })
			await card.getByTestId('inbox-card-pass').click()
			await expect(card).toContainText('Passed. Watching the race')
			for (const page of [a, b]) {
				const recent = page.getByTestId('recent-item').filter({ hasText: item })
				await expect(recent.getByTestId('recent-status')).toHaveText('no-sale', { timeout: 10_000 })
				await expect(recent).toContainText('0 bids')
			}
			await expect(card.getByTestId('inbox-card-outcome')).toHaveText('No-sale (reserve not met).')
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
