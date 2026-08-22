import { test, expect } from '@playwright/test'
import { createBoard, formatWire, getCanvas, waitForBoardReady, waitForData, waitForWS, watchWire } from './helpers.js'
import { formatDeliverySince, markDelivery } from './wire-report.js'

// The gate's failure population contains a shape that clears the connection
// wait and then times out on the first thing the page renders from live data.
// The connection probe proves the socket opened, so the missing evidence is
// one layer up, in the subscription - and the report that names it is only
// worth having if it can be wrong out loud. These tests reach each verdict by
// producing the condition it describes, and pin the DISCRIMINATION rather than
// the wording: every one of them asserts the verdicts it must NOT reach, since
// a report that says something confident about every page is the same as a
// report that says nothing.

const SALE = '/demos/flash-sales'
const PRODUCT_STREAM = 'demos/flash-sales/productList'

/**
 * Relay the socket, dropping the reply to one stream request and forwarding
 * everything else - including the other two streams that arrive in the same
 * batch frame. Dropping the whole frame would leave the page with no data at
 * all, which any wait would notice; withholding one entry leaves a page that
 * is connected, has data, and is still missing the one stream under test.
 */
async function dropStreamReply(page, streamName) {
	await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer()
		let withheld = null
		ws.onMessage((message) => {
			if (typeof message === 'string') {
				try {
					const parsed = JSON.parse(message)
					const requests = Array.isArray(parsed.batch) ? parsed.batch : (parsed.rpc ? [parsed] : [])
					for (const request of requests) {
						if (String(request.rpc).includes(streamName)) withheld = request.id
					}
				} catch { /* binary frames carry no rpc */ }
			}
			server.send(message)
		})
		server.onMessage((message) => {
			if (typeof message === 'string' && withheld !== null) {
				try {
					const parsed = JSON.parse(message)
					if (parsed.topic === '__rpc') {
						if (parsed.event === withheld) return
						const batch = parsed.data?.batch
						if (parsed.event === '__batch' && Array.isArray(batch)) {
							const kept = batch.filter((entry) => entry.id !== withheld)
							if (kept.length !== batch.length) {
								if (kept.length) ws.send(JSON.stringify({ ...parsed, data: { ...parsed.data, batch: kept } }))
								return
							}
						}
					}
				} catch { /* forward anything unreadable unchanged */ }
			}
			ws.send(message)
		})
	})
}

test.describe('The stream probe', () => {
	test('will not vouch for a page whose socket a spec is intercepting', async ({ page }) => {
		watchWire(page)
		await dropStreamReply(page, 'productList')
		await page.goto(SALE)
		await waitForWS(page)

		const failure = await waitForData(page, page.getByTestId('product-card-phone'), {
			what: 'flash-sales product cards',
			stream: PRODUCT_STREAM,
			timeout: 6000
		}).then(() => null, (error) => error)

		expect(failure, 'the product cards must not appear when their stream is withheld').not.toBeNull()
		// The relay a route handler opens is a real socket, so these listeners see
		// the reply the handler chose not to forward. That is the one arrangement
		// where the frames say the data arrived and the page never had it, and a
		// verdict of SUBSCRIPTION SUCCEEDED here would send the reader looking for
		// a rendering bug in a page that was never given anything to render.
		expect(failure.message).toContain('SOCKET ROUTED')
		expect(failure.message).not.toContain('SUBSCRIPTION SUCCEEDED')
		expect(failure.message).not.toContain('NEVER ASKED')
		// The guard has to rest on the interception itself, not on the withheld
		// reply: the record still shows the server answering, which is exactly why
		// the frames alone cannot be trusted to speak for the page here.
		const product = failure.wire.rpcs.find((call) => call.rpc === PRODUCT_STREAM)
		expect(product.ok).toBe(true)
		expect(failure.wire.routed).toBe(true)
	})

	test('a filter that matches nothing names the streams that were requested', async ({ page }) => {
		watchWire(page)
		await page.goto(SALE)
		await waitForWS(page)
		const record = await waitForData(page, page.getByTestId('product-card-phone'), {
			what: 'flash-sales product cards',
			stream: PRODUCT_STREAM
		})

		// A filter naming a stream this page never requests is how a typo, a
		// renamed RPC or a copied call site presents itself. Reported as a
		// finding it reads exactly like a page that subscribed to nothing, so
		// the guard has to be the streams it DID request, by name.
		const report = formatWire(record, { stream: 'demos/flash-sales/noSuchStream' })
		expect(report).toContain('NEVER ASKED')
		expect(report).toContain('streams that WERE requested')
		expect(report).toContain(PRODUCT_STREAM)
	})

	test('a record installed after the socket opened reports no evidence, not an accusation', async ({ browser }) => {
		const context = await browser.newContext()
		const page = await context.newPage()
		try {
			// Deliberately no watchWire and no waitForWS before the navigation:
			// Playwright reports frames only for sockets opened after the
			// listener exists, so this record starts blind. That is the state
			// where "the page never subscribed" would be a false accusation.
			await page.goto(SALE)
			await expect(page.getByTestId('product-card-phone')).toBeVisible({ timeout: 30_000 })

			const report = formatWire(watchWire(page))
			expect(report).toContain('NO EVIDENCE')
			expect(report).not.toContain('NEVER ASKED')
		} finally {
			await context.close()
		}
	})

	test('a page whose streams answered says the data arrived, with the rows to show for it', async ({ page }) => {
		watchWire(page)
		await page.goto(SALE)
		await waitForWS(page)
		const record = await waitForData(page, page.getByTestId('product-card-phone'), {
			what: 'flash-sales product cards',
			stream: PRODUCT_STREAM
		})

		const report = formatWire(record, { stream: PRODUCT_STREAM })
		expect(report).toContain('SUBSCRIPTION SUCCEEDED')
		// Armed before the navigation, so the record covers the socket from its
		// first frame and has no caveat to add. Pinned because the caveat is the
		// difference between a report that measured the page and one that arrived
		// too late to have measured anything, and a capture that never recognised
		// a handshake would print it on every page until it meant nothing.
		expect(record.sawHandshake).toBe(true)
		expect(record.sockets).toBe(1)
		expect(report).not.toContain('PARTIAL RECORD')
		// Not the verdict string alone: the rows are what distinguish an answer
		// that carried the page's data from an empty one that also says ok.
		const product = record.rpcs.find((call) => call.rpc === PRODUCT_STREAM)
		expect(product.ok).toBe(true)
		expect(product.rows).toBeGreaterThanOrEqual(3)
		expect(product.topic).toBe('demos:flash-sales:products')
	})

	test('a write the server accepted is followed by a delivery on the topic its stream named', async ({ page }) => {
		watchWire(page)
		await page.goto('/demos/privacy')
		await waitForWS(page)
		await expect(page.getByTestId('pv-picker-section')).toBeVisible({ timeout: 30_000 })

		const record = watchWire(page)
		const mark = markDelivery(record, 'rawMood')
		// Resolved from the server's own reply, never assumed. A test holding the
		// topic as a constant keeps passing after a rename, asserting about a name
		// nothing publishes to; this fails the moment the two disagree.
		expect(mark.topic).toBe('demos:privacy:agg-raw:round')

		await page.getByTestId('pv-submit-3').click()
		// The note renders only after the RPC resolves, so past this line the
		// server has accepted the write and the only question left is the publish.
		await expect(page.getByTestId('pv-submit-note')).toContainText('Submitted 3/5')

		await expect
			.poll(() => (record.deliveries.get(mark.topic)?.count ?? 0) - mark.count, { timeout: 10_000 })
			.toBeGreaterThan(0)
		const report = formatDeliverySince(record, mark)
		// startsWith, not a substring: NEVER PUBLISHED contains PUBLISHED, and a
		// substring check would read every silence as a delivery.
		expect(report.startsWith('PUBLISHED:')).toBe(true)
		// The payload is the half that separates a reducer that missed a
		// submission from a page that failed to apply one it was given.
		expect(report).toContain('"n":')
	})

	test('the gate a spec navigates for itself still produces a verdict, not a shrug', async ({ page }) => {
		// The other named site, called the way specs actually call it: the SPEC
		// owns the goto, so the record can only be armed afterwards, inside
		// waitForWS. Whether that is early enough is a question about when the
		// client constructs its socket, and nothing in this repo controls that -
		// so it is pinned here rather than assumed. If it ever stops being early
		// enough the record says NO EVIDENCE, which is honest and useless, and
		// this test is what reports the change instead of the diagnostic quietly
		// degrading at the moment someone needs it.
		const boardUrl = await createBoard(page, `Wire gate ${Date.now()}`)

		const fresh = await page.context().newPage()
		try {
			await fresh.goto(boardUrl)
			await waitForWS(fresh)
			await waitForBoardReady(fresh)

			const record = watchWire(fresh)
			expect(record.sockets, 'armed after the navigation, the record must still have seen the socket').toBeGreaterThan(0)
			expect(record.sawHandshake, 'and seen it from its first frame').toBe(true)
			const report = formatWire(record, { stream: 'boards/notes/notes' })
			expect(report).not.toContain('NO EVIDENCE')
			expect(report).not.toContain('NEVER ASKED')
			await expect(getCanvas(fresh)).toBeVisible()
		} finally {
			await fresh.close()
		}
	})
})
