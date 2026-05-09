import { test, expect } from '@playwright/test'

const RUN = `e2e-${Date.now()}`

test.describe('/demos/auctions', () => {
	test('alone on the page: list form is visible but no other bidders, no inbox cards', async ({ page }) => {
		await page.goto('/demos/auctions')
		await expect(page.getByTestId('alone-badge')).toBeVisible({ timeout: 5_000 })
		await expect(page.getByTestId('inbox-empty')).toBeVisible()
		await expect(page.getByTestId('active-empty')).toBeVisible()
		await expect(page.getByTestId('list-submit')).toContainText('0 bidders')
	})

	test('happy path: A lists, B bids, A sees sold to B at the bid price', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/auctions')
			await b.goto('/demos/auctions')

			await expect.poll(
				async () => (await a.getByTestId('list-submit').textContent()) ?? '',
				{ timeout: 8_000 }
			).toMatch(/1 bidder/)

			const item = `lot-${RUN}-happy`
			await a.getByTestId('list-item-input').fill(item)
			await a.getByTestId('list-start-input').fill('10')
			await a.getByTestId('list-reserve-input').fill('15')
			await a.getByTestId('list-duration-input').fill('5')
			await a.getByTestId('list-submit').click()

			const bCard = b.getByTestId('inbox-card').filter({ hasText: item })
			await expect(bCard).toBeVisible({ timeout: 8_000 })

			await bCard.getByTestId('inbox-card-amount').fill('42')
			await bCard.getByTestId('inbox-card-bid').click()

			const result = a.getByTestId('list-result-text')
			await expect(result).toContainText('sold', { timeout: 12_000 })
			await expect(result).toContainText('$42')

			const recentRow = a.getByTestId('recent-item').filter({ hasText: item })
			await expect(recentRow).toBeVisible({ timeout: 5_000 })
			await expect(recentRow.getByTestId('recent-status')).toHaveText('sold')
			await expect(recentRow.getByTestId('recent-price')).toHaveText('$42')

			const bOutcome = bCard.getByTestId('inbox-card-outcome')
			await expect(bOutcome).toContainText('won')
			await expect(bOutcome).toContainText('$42')
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('three-bidder race: ascending outbids, live waterfall on the seller, highest wins', async ({ browser }) => {
		const [ctxA, ctxB, ctxC, ctxD] = await Promise.all([
			browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()
		])
		const [a, b, c, d] = await Promise.all([
			ctxA.newPage(), ctxB.newPage(), ctxC.newPage(), ctxD.newPage()
		])
		try {
			await Promise.all([
				a.goto('/demos/auctions'),
				b.goto('/demos/auctions'),
				c.goto('/demos/auctions'),
				d.goto('/demos/auctions')
			])

			await expect.poll(
				async () => (await a.getByTestId('list-submit').textContent()) ?? '',
				{ timeout: 10_000 }
			).toMatch(/3 bidders/)

			const item = `lot-${RUN}-race`
			await a.getByTestId('list-item-input').fill(item)
			await a.getByTestId('list-start-input').fill('5')
			await a.getByTestId('list-reserve-input').fill('5')
			await a.getByTestId('list-duration-input').fill('8')
			await a.getByTestId('list-submit').click()

			const bCard = b.getByTestId('inbox-card').filter({ hasText: item })
			const cCard = c.getByTestId('inbox-card').filter({ hasText: item })
			const dCard = d.getByTestId('inbox-card').filter({ hasText: item })
			await expect(bCard).toBeVisible({ timeout: 8_000 })
			await expect(cCard).toBeVisible({ timeout: 8_000 })
			await expect(dCard).toBeVisible({ timeout: 8_000 })

			const sellerActive = a.getByTestId('active-card').filter({ hasText: item })
			await expect(sellerActive).toBeVisible({ timeout: 5_000 })

			// Bid ascending so each click is a valid outbid (the Bid button
			// is gated to amount > current top). After each bid lands, the
			// seller's active card waterfall grows. The third bid is the
			// last one to settle, so Promise.allSettled wraps the auction
			// up immediately after.
			await bCard.getByTestId('inbox-card-amount').fill('20')
			await bCard.getByTestId('inbox-card-bid').click()
			await expect(sellerActive.getByTestId('active-card-bid')).toHaveCount(1, { timeout: 5_000 })
			await expect(sellerActive.getByTestId('active-card-top')).toContainText('$20')

			await dCard.getByTestId('inbox-card-amount').fill('45')
			await dCard.getByTestId('inbox-card-bid').click()
			await expect(sellerActive.getByTestId('active-card-bid')).toHaveCount(2, { timeout: 5_000 })
			await expect(sellerActive.getByTestId('active-card-top')).toContainText('$45')

			await cCard.getByTestId('inbox-card-amount').fill('60')
			await cCard.getByTestId('inbox-card-bid').click()

			const result = a.getByTestId('list-result-text')
			await expect(result).toContainText('sold', { timeout: 15_000 })
			await expect(result).toContainText('$60')

			const recentRow = a.getByTestId('recent-item').filter({ hasText: item })
			await expect(recentRow.getByTestId('recent-price')).toHaveText('$60')
		} finally {
			await ctxA.close()
			await ctxB.close()
			await ctxC.close()
			await ctxD.close()
		}
	})

	test('reserve-not-met: B bids below reserve, A sees no-sale', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/auctions')
			await b.goto('/demos/auctions')

			await expect.poll(
				async () => (await a.getByTestId('list-submit').textContent()) ?? '',
				{ timeout: 8_000 }
			).toMatch(/1 bidder/)

			const item = `lot-${RUN}-noreserve`
			await a.getByTestId('list-item-input').fill(item)
			await a.getByTestId('list-start-input').fill('10')
			await a.getByTestId('list-reserve-input').fill('500')
			await a.getByTestId('list-duration-input').fill('4')
			await a.getByTestId('list-submit').click()

			const bCard = b.getByTestId('inbox-card').filter({ hasText: item })
			await expect(bCard).toBeVisible({ timeout: 8_000 })
			await bCard.getByTestId('inbox-card-amount').fill('15')
			await bCard.getByTestId('inbox-card-bid').click()

			const result = a.getByTestId('list-result-text')
			await expect(result).toContainText('no-sale', { timeout: 10_000 })

			const recentRow = a.getByTestId('recent-item').filter({ hasText: item })
			await expect(recentRow.getByTestId('recent-status')).toHaveText('no-sale')
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('timeout: B never replies, A sees no-sale after the deadline', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/auctions')
			await b.goto('/demos/auctions')

			await expect.poll(
				async () => (await a.getByTestId('list-submit').textContent()) ?? '',
				{ timeout: 8_000 }
			).toMatch(/1 bidder/)

			const item = `lot-${RUN}-timeout`
			await a.getByTestId('list-item-input').fill(item)
			await a.getByTestId('list-start-input').fill('10')
			await a.getByTestId('list-reserve-input').fill('15')
			await a.getByTestId('list-duration-input').fill('3')
			await a.getByTestId('list-submit').click()

			// B's card lands but they don't click anything.
			const bCard = b.getByTestId('inbox-card').filter({ hasText: item })
			await expect(bCard).toBeVisible({ timeout: 8_000 })

			// After ~5s the server's push deadline plus grace fires no-sale.
			const result = a.getByTestId('list-result-text')
			await expect(result).toContainText('no-sale', { timeout: 12_000 })

			const recentRow = a.getByTestId('recent-item').filter({ hasText: item })
			await expect(recentRow.getByTestId('recent-status')).toHaveText('no-sale')
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
