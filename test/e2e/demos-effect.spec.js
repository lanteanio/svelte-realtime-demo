import { test, expect } from '@playwright/test'
import { confirmAndClick, expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

const PRODUCTS = [
	{ name: 'bagel', price: 4 },
	{ name: 'coffee', price: 5 },
	{ name: 'cookie', price: 3 },
	{ name: 'muffin', price: 6 }
]
const FEED_CAP = 30

async function openEffect(page) {
	await page.goto('/demos/effect')
	await waitForWS(page)
	await expect(page.getByTestId('place-product').locator('option')).toHaveCount(PRODUCTS.length)
}

async function clearFeeds(page) {
	await confirmAndClick(page.getByTestId('clear'))
	await Promise.all([
		expect(page.getByTestId('orders-row')).toHaveCount(0),
		expect(page.getByTestId('audit-row')).toHaveCount(0),
		expect(page.getByTestId('notifications-row')).toHaveCount(0)
	])
}

async function place(page, product, qty, { enter = false } = {}) {
	await page.getByTestId('place-product').selectOption(product)
	await page.getByTestId('place-qty').fill(String(qty))
	if (enter) await page.getByTestId('place-qty').press('Enter')
	else await page.getByTestId('place-submit').click()
}

async function expectCounts(page, count) {
	await Promise.all([
		expect(page.getByTestId('orders-row')).toHaveCount(count, { timeout: 10_000 }),
		expect(page.getByTestId('audit-row')).toHaveCount(count, { timeout: 10_000 }),
		expect(page.getByTestId('notifications-row')).toHaveCount(count, { timeout: 10_000 })
	])
}

function rowsWith(page, testId, text) {
	return page.getByTestId(testId).filter({ hasText: text })
}

async function burst(page) {
	const button = page.getByTestId('burst')
	await button.click()
	await expect(button).toBeEnabled()
}

test.describe('/demos/effect', () => {
	test('renders the full product/quantity surface and hydrated identity', async ({ page }) => {
		await openEffect(page)
		await expect(page.getByRole('heading', { name: 'live.effect: one publish, three streams' })).toBeVisible()
		await expect(page.getByTestId('place-section')).toBeVisible()
		await expect(page.getByTestId('columns')).toBeVisible()
		for (const id of ['orders-column', 'audit-column', 'notifications-column']) {
			await expect(page.getByTestId(id)).toBeVisible()
		}

		const options = await page.getByTestId('place-product').locator('option').evaluateAll((nodes) => (
			nodes.map((node) => ({ value: node.value, text: node.textContent?.trim() }))
		))
		expect(options).toEqual(PRODUCTS.map((product) => ({
			value: product.name,
			text: `${product.name} ($${product.price})`
		})))
		await expect(page.getByTestId('place-qty')).toHaveAttribute('min', '1')
		await expect(page.getByTestId('place-qty')).toHaveAttribute('max', '20')
		await expect(page.getByTestId('place-qty')).toHaveAttribute('step', '1')
		await expect(page.locator('header strong')).not.toHaveText('')
	})

	test('feed cards stay stacked at 640px and become three readable columns at 768px', async ({ page }) => {
		await page.setViewportSize({ width: 640, height: 900 })
		await openEffect(page)
		const columns = page.getByTestId('columns')
		const trackCount = () => columns.evaluate((element) => (
			getComputedStyle(element).gridTemplateColumns.split(' ').length
		))
		expect(await trackCount()).toBe(1)

		await page.setViewportSize({ width: 768, height: 1024 })
		await expect.poll(trackCount).toBe(3)
		const widths = await columns.locator(':scope > *').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width))
		for (const width of widths) expect(width).toBeGreaterThan(200)
	})

	test('each product produces the exact order total and one correlated audit + notification', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		const buyer = (await page.locator('header strong').textContent())?.trim() ?? ''

		for (let index = 0; index < PRODUCTS.length; index++) {
			const product = PRODUCTS[index]
			const qty = index + 1
			const total = product.price * qty
			await place(page, product.name, qty)
			await expectCounts(page, index + 1)

			const order = rowsWith(page, 'orders-row', `${qty}x ${product.name}`)
			await expect(order).toHaveCount(1)
			await expect(order.locator('span').last()).toHaveText(`$${total}`)
			const audit = rowsWith(page, 'audit-row', `${qty}x ${product.name} for $${total} placed by ${buyer}`)
			const notification = rowsWith(page, 'notifications-row', `Thanks ${buyer}! Your ${qty}x ${product.name} is confirmed.`)
			await expect(audit).toHaveCount(1)
			await expect(notification).toHaveCount(1)
		}

		await page.waitForTimeout(500)
		await expectCounts(page, PRODUCTS.length)
		await expect(page.getByTestId('orders-product').allTextContents()).resolves.toEqual([
			'4x muffin', '3x cookie', '2x coffee', '1x bagel'
		])
	})

	test('native quantity bounds reject underflow/overflow/step mismatch; Enter submits a valid max order', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		const qty = page.getByTestId('place-qty')

		for (const invalid of ['0', '21', '2.5', '']) {
			await qty.fill(invalid)
			expect(await qty.evaluate((input) => input.checkValidity())).toBe(false)
			await page.getByTestId('place-submit').click()
			await page.waitForTimeout(150)
			await expect(page.getByTestId('orders-row')).toHaveCount(0)
		}

		await place(page, 'cookie', 20, { enter: true })
		await expectCounts(page, 1)
		await expect(rowsWith(page, 'orders-row', '20x cookie').locator('span').last()).toHaveText('$60')
	})

	test('Burst (5) emits the documented composition exactly once through both effects', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		await burst(page)
		await expectCounts(page, 5)

		const products = (await page.getByTestId('orders-product').allTextContents()).sort()
		expect(products).toEqual(['1x bagel', '1x muffin', '2x bagel', '2x coffee', '3x cookie'].sort())
		await page.waitForTimeout(500)
		await expectCounts(page, 5)
	})

	test('seven bursts evict every feed independently at the shared 30-row cap', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		for (let index = 0; index < 7; index++) await burst(page)
		await expectCounts(page, FEED_CAP)
		await expect(page.getByTestId('orders-column').getByRole('heading')).toHaveText(`Orders (${FEED_CAP})`)
		await expect(page.getByTestId('audit-column').getByRole('heading')).toHaveText(`Audit (${FEED_CAP})`)
		await expect(page.getByTestId('notifications-column').getByRole('heading')).toHaveText(`Notifications (${FEED_CAP})`)
		await page.waitForTimeout(500)
		await expectCounts(page, FEED_CAP)
	})

	test('clear removes all three feeds without deleted-order effects repopulating adjacent feeds', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		await place(page, 'coffee', 2)
		await expectCounts(page, 1)
		await clearFeeds(page)
		await expect(page.getByTestId('orders-empty')).toBeVisible()
		await expect(page.getByTestId('audit-empty')).toBeVisible()
		await expect(page.getByTestId('notifications-empty')).toBeVisible()
		await page.waitForTimeout(500)
		await expectCounts(page, 0)
	})

	test('two tabs receive orders and effects in both directions, then clear together', async ({ browser }) => {
		const context = await browser.newContext()
		const a = await context.newPage()
		const b = await context.newPage()
		try {
			await openEffect(a)
			await openEffect(b)
			await clearFeeds(a)
			await expectCounts(b, 0)

			await place(a, 'coffee', 2)
			await expectCounts(a, 1)
			await expectCounts(b, 1)
			await place(b, 'cookie', 3)
			await expectCounts(a, 2)
			await expectCounts(b, 2)

			await clearFeeds(b)
			await expectCounts(a, 0)
			await expectCounts(b, 0)
		} finally {
			await context.close()
		}
	})

	test('every downstream row wears the order that caused it', async ({ page }) => {
		await openEffect(page)
		await clearFeeds(page)
		const buyer = (await page.locator('header strong').textContent())?.trim() ?? ''
		await place(page, 'coffee', 2)
		await expectCounts(page, 1)

		const orderRef = (await page.getByTestId('orders-ref').textContent())?.trim()
		expect(orderRef).toMatch(/^#[0-9a-f]{8}$/)
		await expect(page.getByTestId('audit-ref')).toHaveText(orderRef)
		await expect(page.getByTestId('notifications-ref')).toHaveText(orderRef)
		// The buyer dot travels too, so the correlation is visible even
		// when the ids are not being read - and it names its buyer for
		// everyone who cannot use the color.
		for (const row of ['orders-row', 'audit-row', 'notifications-row']) {
			await expect(page.getByTestId(row).locator(`[title="${buyer}"]`)).toHaveCount(1)
		}
	})

	test('a publish on a short viewport leaves a receipt whose jump lands on the feeds', async ({ page }) => {
		await page.setViewportSize({ width: 844, height: 390 })
		await openEffect(page)
		await clearFeeds(page)
		await page.getByTestId('place-qty').fill('3')
		await page.getByTestId('place-submit').click()

		const receipt = page.getByTestId('receipt')
		await expect(receipt).toContainText('3x bagel placed')
		await expectCounts(page, 1)
		const orderRef = (await page.getByTestId('orders-ref').textContent())?.trim()
		await expect(receipt).toContainText(orderRef)

		const columns = page.getByTestId('columns')
		const columnsTop = async () => (await columns.boundingBox()).y
		expect(await columnsTop()).toBeGreaterThan(390)
		await page.getByTestId('receipt-jump').click()
		await expect.poll(columnsTop, { timeout: 5_000 }).toBeLessThan(200)
		expect(await columnsTop()).toBeGreaterThanOrEqual(0)
	})

	test('the three actions stay one group below the inputs on a phone', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await openEffect(page)
		const box = async (id) => await page.getByTestId(id).boundingBox()
		const [qty, placeBtn, burstBtn, clearBtn] = await Promise.all([
			box('place-qty'), box('place-submit'), box('burst'), box('clear')
		])
		expect(placeBtn.y).toBeGreaterThan(qty.y + qty.height - 1)
		expect(burstBtn.y).toBeCloseTo(placeBtn.y, 0)
		expect(clearBtn.y).toBeCloseTo(placeBtn.y, 0)
	})

	test('the instructive text clears the contrast floor it used to duck under', async ({ page }) => {
		await openEffect(page)
		const opacityOf = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity)
		expect(await opacityOf(page.locator('aside.text-xs'))).toBe('0.7')
		expect(await opacityOf(page.getByTestId('orders-column').locator('p').first())).toBe('0.7')
		await clearFeeds(page)
		expect(await opacityOf(page.getByTestId('orders-empty'))).toBe('0.7')
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await openEffect(page)
			await expectTouchTarget(page.getByTestId('place-product'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('place-qty'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('place-submit'))
			await expectTouchTarget(page.getByTestId('burst'))
			await expectTouchTarget(page.getByTestId('clear'))
		} finally {
			await context.close()
		}
	})
})
