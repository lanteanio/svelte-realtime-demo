import { test, expect } from '@playwright/test'

const ROOM_OPEN = `e2e-${Date.now()}`

test.describe('/demos/chat', () => {
	test('room picker links to the three demo rooms', async ({ page }) => {
		await page.goto('/demos/chat')
		await expect(page.getByTestId('room-link-general')).toBeVisible()
		await expect(page.getByTestId('room-link-random')).toBeVisible()
		await expect(page.getByTestId('room-link-private')).toBeVisible()
	})

	test('private room shows the FORBIDDEN denial banner', async ({ page }) => {
		await page.goto('/demos/chat/private')
		await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 5_000 })
		// Send affordances are disabled in a denied room.
		await expect(page.getByTestId('send-button')).toBeDisabled()
		await expect(page.getByTestId('retry-five-button')).toBeDisabled()
	})

	test('happy path: send a message, see it appear, second context observes it', async ({ browser }) => {
		const room = `${ROOM_OPEN}-happy`
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto(`/demos/chat/${room}`)
			await b.goto(`/demos/chat/${room}`)

			// Both contexts subscribed -- presence list reports two users.
			await expect.poll(
				async () => Number((await a.getByTestId('presence-count').textContent())?.split(' ')[0] ?? 0),
				{ timeout: 5_000 }
			).toBeGreaterThanOrEqual(2)

			const text = `hello-${Date.now()}`
			await a.getByTestId('message-input').fill(text)
			await a.getByTestId('send-button').click()

			await expect(a.getByTestId('messages')).toContainText(text, { timeout: 5_000 })
			await expect(b.getByTestId('messages')).toContainText(text, { timeout: 5_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('Retry x5 with same idempotencyKey posts ONE message', async ({ page }) => {
		const room = `${ROOM_OPEN}-retry`
		await page.goto(`/demos/chat/${room}`)
		const text = `retry-${Date.now()}`
		await page.getByTestId('message-input').fill(text)
		await page.getByTestId('retry-five-button').click()

		// Wait for the message to land.
		await expect(page.getByTestId('messages')).toContainText(text, { timeout: 5_000 })
		await page.waitForTimeout(500)

		// The message text appears exactly once across all messages, even
		// though five RPCs were fired with the same idempotencyKey.
		const matches = await page
			.getByTestId('messages')
			.locator(`li:has-text("${text}")`)
			.count()
		expect(matches).toBe(1)
	})
})
