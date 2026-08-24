import { waitForData, waitForWS, watchWire } from './helpers.js'

export const PRODUCT_STREAM = 'demos/flash-sales/productList'

export async function openSale(page) {
	// Armed before the navigation so the record covers the socket from its first
	// frame. The product cards only exist once the productList stream answers,
	// so a card that never appears is a fact about that stream.
	watchWire(page)
	await page.goto('/demos/flash-sales')
	await waitForWS(page)
	await waitForData(page, page.getByTestId('product-card-phone'), { what: 'flash-sales product cards', stream: PRODUCT_STREAM })
}
