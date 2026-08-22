import { test, expect } from '@playwright/test'
import { confirmAndClick, expectTouchTarget, openTouchPage, waitForData, waitForWS, watchWire } from './helpers.js'

const PRODUCTS = [
	{ id: 'phone', name: 'Wireless earbuds', original: 99, sale: 29, stock: 5 },
	{ id: 'watch', name: 'Smart watch', original: 299, sale: 119, stock: 3 },
	{ id: 'speaker', name: 'Bluetooth speaker', original: 149, sale: 59, stock: 8 }
]

async function openSale(page) {
	// Armed before the navigation so the record covers the socket from its first
	// frame. The product cards only exist once the productList stream answers,
	// so a card that never appears is a fact about that stream.
	watchWire(page)
	await page.goto('/demos/flash-sales')
	await waitForWS(page)
	await waitForData(page, page.getByTestId('product-card-phone'), { what: 'flash-sales product cards', stream: 'demos/flash-sales/productList' })
}

async function reset(page) {
	await openSale(page)
	await confirmAndClick(page.getByTestId('reset'))
	for (const product of PRODUCTS) {
		await expect(page.getByTestId(`product-stock-${product.id}`)).toHaveText(`${product.stock} / ${product.stock} left`)
		await expect(page.getByTestId(`product-sold-${product.id}`)).toHaveText('sold: 0')
	}
	await expect(page.getByTestId('sales-row')).toHaveCount(0)
	await expect(page.getByTestId('coupon-pool')).toHaveText('50')
}

function stockBadge(page, product) {
	return page.getByTestId(`product-stock-${product}`)
}

function soldCount(page, product) {
	return page.getByTestId(`product-sold-${product}`)
}

function tallyNumber(page, testId) {
	return page.getByTestId(testId).textContent().then((text) => Number(text?.match(/^\d+/)?.[0] ?? NaN))
}

async function setStress(page, product, count) {
	await page.getByTestId('stress-target').selectOption(product)
	await page.getByTestId('stress-count').fill(String(count))
	await expect(page.getByText(`Count (${count})`, { exact: true })).toBeVisible()
	await expect(page.getByTestId('stress-go')).toHaveText(`Spam ${count} buys`)
}

async function runStress(page) {
	await page.getByTestId('stress-go').click()
	// The tally renders live during the burst; completion is the button
	// returning from "Running..." to its rest label.
	await expect(page.getByTestId('stress-result')).toBeVisible({ timeout: 20_000 })
	await expect(page.getByTestId('stress-go')).not.toHaveText('Running...', { timeout: 30_000 })
}

test.describe('/demos/flash-sales', () => {
	test('renders the complete catalog, prices, stock, stress controls, coupon, and identity', async ({ page }) => {
		await reset(page)
		await expect(page.getByRole('heading', { name: 'Flash sales: atomic inventory under contention' })).toBeVisible()
		await expect(page.locator('header strong')).not.toHaveText('')
		await expect(page.getByTestId('coupon-section')).toContainText('Coupon: SAVE20 (one per user)')
		await expect(page.getByTestId('coupon-claim')).toHaveText('Claim coupon')

		for (const product of PRODUCTS) {
			const card = page.getByTestId(`product-card-${product.id}`)
			await expect(card.getByTestId('product-name')).toHaveText(product.name)
			await expect(card.getByTestId('product-saleprice')).toHaveText(`$${product.sale}`)
			await expect(card.getByText(`$${product.original}`, { exact: true })).toBeVisible()
			await expect(card.getByTestId(`product-buy-${product.id}`)).toHaveText(`Buy $${product.sale}`)
			await expect(card.locator('progress')).toHaveAttribute('value', '1')
		}

		const stressOptions = await page.getByTestId('stress-target').locator('option').evaluateAll((nodes) => (
			nodes.map((node) => ({ value: node.value, text: node.textContent?.trim() }))
		))
		expect(stressOptions).toEqual(PRODUCTS.map((product) => ({ value: product.id, text: product.name })))
		await expect(page.getByTestId('stress-count')).toHaveAttribute('min', '1')
		await expect(page.getByTestId('stress-count')).toHaveAttribute('max', '50')
		await expect(page.getByTestId('stress-count')).toHaveAttribute('step', '1')
	})

	test('stock badges never shrink, wrap, or clip across the reported viewports', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 568 })
		await reset(page)
		for (const width of [320, 640, 768, 844, 1024]) {
			await page.setViewportSize({ width, height: 900 })
			for (const product of PRODUCTS) {
				const badge = stockBadge(page, product.id)
				const geometry = await badge.evaluate((element) => {
					const style = getComputedStyle(element)
					const box = element.getBoundingClientRect()
					const cardBox = element.closest('.card').getBoundingClientRect()
					return {
						whiteSpace: style.whiteSpace,
						flexShrink: style.flexShrink,
						clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
						insideCard: box.left >= cardBox.left && box.right <= cardBox.right
					}
				})
				expect(geometry, `${product.id} stock badge at ${width}px`).toEqual({
					whiteSpace: 'nowrap',
					flexShrink: '0',
					clipped: false,
					insideCard: true
				})
			}
		}
	})

	test('one buy of every product updates exact stock/sold math, outcome, and newest-first sales', async ({ page }) => {
		await reset(page)
		const buyer = (await page.locator('header strong').textContent())?.trim() ?? ''
		for (const [index, product] of PRODUCTS.entries()) {
			await page.getByTestId(`product-buy-${product.id}`).click()
			await expect(stockBadge(page, product.id)).toHaveText(`${product.stock - 1} / ${product.stock} left`)
			await expect(soldCount(page, product.id)).toHaveText('sold: 1')
			await expect(page.getByTestId('buy-outcome-kind')).toHaveText('sold')
			await expect(page.getByTestId('buy-outcome')).toContainText(`${product.name} for $${product.sale}`)
			await expect(page.getByTestId('sales-row')).toHaveCount(index + 1)
			await expect(page.getByTestId('sales-row').first()).toContainText(`${buyer} bought ${product.name}`)
			await expect(page.getByTestId('sales-row').first()).toContainText(`$${product.sale}`)
		}
	})

	test('an accidental double-click spends one unit, not two', async ({ page }) => {
		await reset(page)
		await page.getByTestId('product-buy-phone').dblclick()
		await expect(stockBadge(page, 'phone')).toHaveText('4 / 5 left')
		await expect(soldCount(page, 'phone')).toHaveText('sold: 1')
		await expect(page.getByTestId('sales-row')).toHaveCount(1)
		await page.waitForTimeout(300)
		await expect(page.getByTestId('sales-row')).toHaveCount(1)
	})

	test('selling out disables the card, then reset restores every product and clears outcomes/feed', async ({ page }) => {
		await reset(page)
		const buy = page.getByTestId('product-buy-watch')
		for (let count = 1; count <= 3; count++) {
			await buy.click()
			await expect(soldCount(page, 'watch')).toHaveText(`sold: ${count}`)
		}
		await expect(page.getByTestId('product-soldout-watch')).toHaveText('SOLD OUT')
		await expect(buy).toBeDisabled()
		await expect(page.getByTestId('product-card-watch').locator('progress')).toHaveAttribute('value', '0')
		await expect(page.getByTestId('sales-row')).toHaveCount(3)

		await confirmAndClick(page.getByTestId('reset'))
		await expect(stockBadge(page, 'watch')).toHaveText('3 / 3 left')
		await expect(soldCount(page, 'watch')).toHaveText('sold: 0')
		await expect(buy).toBeEnabled()
		await expect(page.getByTestId('buy-outcome')).toHaveCount(0)
		await expect(page.getByTestId('sales-empty')).toBeVisible()
	})

	test('stress tally conserves all 25 calls, surfaces lock timeouts, and never oversells', async ({ page }) => {
		test.setTimeout(35_000)
		await reset(page)
		await setStress(page, 'phone', 25)
		await runStress(page)

		const [ok, soldOut, lockTimeout, other] = await Promise.all([
			tallyNumber(page, 'stress-ok'),
			tallyNumber(page, 'stress-soldout'),
			tallyNumber(page, 'stress-locktimeout'),
			page.getByTestId('stress-other').count().then(async (count) => count ? tallyNumber(page, 'stress-other') : 0)
		])
		expect(ok).toBe(5)
		expect(soldOut).toBeGreaterThan(0)
		expect(lockTimeout).toBeGreaterThan(0)
		expect(other).toBe(0)
		expect(ok + soldOut + lockTimeout + other).toBe(25)
		await expect(page.getByTestId('product-soldout-phone')).toBeVisible()
		await expect(soldCount(page, 'phone')).toHaveText('sold: 5')
		await expect(page.getByTestId('sales-row')).toHaveCount(5)
	})

	test('reset permits a fresh claim', async ({ page }) => {
		// The claim is wrapped in live.idempotent keyed on the visitor, so the
		// reset has to drop the cached replies as well as the holders set. Miss
		// that and a visitor who already claimed gets their FIRST response
		// replayed without the body running at all: no SADD, no DECR, and the
		// pool sits at exactly where the reset left it.
		//
		// The second claim below is what pins it, and it is only a real check
		// because the page now displays what Redis holds rather than what the
		// claim RPC returned - a replayed reply carries the ORIGINAL 49, so the
		// assertion passed against a number nobody had measured.
		await reset(page)
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')

		await confirmAndClick(page.getByTestId('reset'))
		await expect(page.getByTestId('coupon-pool')).toHaveText('50')
		await expect(page.getByTestId('coupon-claim')).toHaveText('Claim coupon')
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
		// A claim is one per visitor per reset, not one per click: the fresh
		// claim above must still be deduped afterwards, or the reset has traded
		// a stale cache for no cache at all.
		await expect(page.getByTestId('coupon-claim')).toHaveText('Re-check coupon')
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-result')).toHaveText(/Already claimed:.*SAVE20/)
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
	})

	test('coupon decrements once per user across re-check and reload', async ({ page }) => {
		await reset(page)
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-result')).toHaveText(/Claimed:.*SAVE20/)
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
		await expect(page.getByTestId('coupon-claim')).toHaveText('Re-check coupon')

		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-result')).toHaveText(/Already claimed:.*SAVE20/)
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('coupon-claim')).toHaveText('Re-check coupon')
		await page.getByTestId('coupon-claim').click()
		await expect(page.getByTestId('coupon-pool')).toHaveText('49')
	})

	test('the buy outcome never moves the stress panel, at a narrow rung', async ({ page }) => {
		// 320 is where a one-line reservation stops being enough: the outcome
		// wraps and a minimum-height slot grows with it.
		await page.setViewportSize({ width: 320, height: 900 })
		await reset(page)
		const stressTop = () => page.getByTestId('stress-section').evaluate(
			(element) => Math.round(element.getBoundingClientRect().top + window.scrollY)
		)

		const atRest = await stressTop()
		expect(atRest, 'stress panel must be measurable').toBeGreaterThan(0)

		// A normal success outcome.
		await page.getByTestId('product-buy-phone').click()
		await expect(page.getByTestId('buy-outcome')).toBeVisible()
		expect(await stressTop(), 'a normal outcome must not move the panel').toBe(atRest)

		const slotHeight = () => page.getByTestId('buy-outcome-slot').evaluate(
			(element) => Math.round(element.getBoundingClientRect().height)
		)
		const boundedHeight = await slotHeight()

		// The real messages happen to fit one line even at 320, so a natural
		// outcome cannot prove the region is BOUNDED - only that this message
		// fits. Force the worst case directly: a message far longer than any
		// the server sends. A minimum-height slot grows with it; a bounded one
		// keeps its height and scrolls internally.
		await page.getByTestId('buy-outcome').evaluate((element) => {
			element.querySelector('span').textContent = 'sold - '.concat('a really long outcome detail that wraps many times over '.repeat(6))
		})
		expect(await slotHeight(), 'the outcome region must be bounded, not merely have a minimum').toBe(boundedHeight)
		expect(await stressTop(), 'an overlong outcome must not move the panel either').toBe(atRest)
	})

	test('the stress tally fills in while the burst is still running', async ({ page }) => {
		test.setTimeout(90_000)
		await reset(page)
		const TOTAL = 40
		await setStress(page, 'phone', TOTAL)

		const tally = async () => {
			const counts = await Promise.all(
				['stress-ok', 'stress-soldout', 'stress-locktimeout'].map((id) =>
					page.getByTestId(id).textContent().then((t) => Number(t?.match(/^\d+/)?.[0] ?? 0)).catch(() => 0)
				)
			)
			return counts.reduce((a, b) => a + b, 0)
		}

		await page.getByTestId('stress-go').click()

		// Sample repeatedly and keep the strongest evidence of PARTIAL progress
		// observed while the button still said Running. An implementation that
		// only publishes its tally after every promise settles can never
		// produce such a sample.
		let sawPartialWhileRunning = false
		for (let i = 0; i < 120 && !sawPartialWhileRunning; i += 1) {
			const label = await page.getByTestId('stress-go').textContent().catch(() => '')
			if (!label?.includes('Running')) break
			const sum = await tally()
			if (sum > 0 && sum < TOTAL) sawPartialWhileRunning = true
			else await page.waitForTimeout(50)
		}
		expect(sawPartialWhileRunning, 'tally must be partially filled while the burst runs').toBe(true)

		await expect(page.getByTestId('stress-go')).not.toHaveText('Running...', { timeout: 40_000 })
		expect(await tally(), 'every attempt must be accounted for once it finishes').toBe(TOTAL)
	})

	// The holders set and the pool are written by one atomic script, so they
	// cannot disagree. Two DIFFERENT identities is what tests that: the pool
	// must fall by exactly one per holder, and each holder must be recorded
	// exactly once. A single-identity test cannot see a pool that moved without
	// a holder being recorded, or the reverse - the two failure directions the
	// separate SADD and DECR left open between them.
	test('two visitors take one coupon each, and the pool agrees with the holders', async ({ browser }) => {
		const first = await browser.newContext()
		const second = await browser.newContext()
		try {
			const a = await first.newPage()
			await reset(a)
			const b = await second.newPage()
			await openSale(b)

			await a.getByTestId('coupon-claim').click()
			await expect(a.getByTestId('coupon-pool')).toHaveText('49')
			await b.getByTestId('coupon-claim').click()
			await expect(b.getByTestId('coupon-pool')).toHaveText('48')

			// Each is recorded, so neither can take a second.
			for (const page of [a, b]) {
				await expect(page.getByTestId('coupon-claim')).toHaveText('Re-check coupon')
				await page.getByTestId('coupon-claim').click()
				await expect(page.getByTestId('coupon-result')).toHaveText(/Already claimed:.*SAVE20/)
			}
			// Two holders, two coupons gone, and the re-checks moved nothing.
			await expect(a.getByTestId('coupon-pool')).toHaveText('48')
			await expect(b.getByTestId('coupon-pool')).toHaveText('48')
		} finally {
			await Promise.allSettled([first.close(), second.close()])
		}
	})

	test('a tab opened before the claim still reads Already claimed, and the pool moves once', async ({ browser }) => {
		// One context so both tabs carry the SAME identity cookie - the coupon
		// rule is per user, so two contexts would be two users and prove nothing.
		const context = await browser.newContext()
		try {
			const b = await context.newPage()
			await reset(b)
			const a = await context.newPage()
			await openSale(a)

			// B's snapshot predates A's claim and stays at 50: it holds no live
			// subscription to the pool. Any classification that trusts this
			// number, or the idempotent replay's identical body, mislabels B's
			// click as a fresh claim.
			await expect(b.getByTestId('coupon-pool')).toHaveText('50')

			await a.getByTestId('coupon-claim').click()
			await expect(a.getByTestId('coupon-result')).toHaveText(/Claimed:.*SAVE20/)
			await expect(a.getByTestId('coupon-pool')).toHaveText('49')

			await b.getByTestId('coupon-claim').click()
			await expect(b.getByTestId('coupon-result')).toHaveText(/Already claimed:.*SAVE20/)
			// And the pool moved exactly once across both tabs.
			await expect(b.getByTestId('coupon-pool')).toHaveText('49')
			await a.reload()
			await waitForWS(a)
			await expect(a.getByTestId('coupon-pool')).toHaveText('49')
		} finally {
			await context.close()
		}
	})

	test('two tabs converge on concurrent stock changes and a cluster-wide reset', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await reset(a)
			await openSale(b)
			await expect(stockBadge(b, 'phone')).toHaveText('5 / 5 left')

			await Promise.all([
				a.getByTestId('product-buy-phone').click(),
				b.getByTestId('product-buy-phone').click()
			])
			for (const page of [a, b]) {
				await expect(stockBadge(page, 'phone')).toHaveText('3 / 5 left')
				await expect(soldCount(page, 'phone')).toHaveText('sold: 2')
				await expect(page.getByTestId('sales-row')).toHaveCount(2)
			}

			await confirmAndClick(b.getByTestId('reset'))
			for (const page of [a, b]) {
				await expect(stockBadge(page, 'phone')).toHaveText('5 / 5 left')
				await expect(page.getByTestId('sales-row')).toHaveCount(0)
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('every Buy button meets the 44px height floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openSale(page)
			for (const product of PRODUCTS) {
				// Full-width CTA: height is the constrained axis.
				await expectTouchTarget(page.getByTestId(`product-buy-${product.id}`), { minWidth: 0 })
			}
		} finally {
			await context.close()
		}
	})
})
