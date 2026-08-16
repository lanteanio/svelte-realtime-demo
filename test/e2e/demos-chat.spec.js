import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/chat and /demos/chat/[roomId] on
// a single instance. Drives every interactive element - room links, message
// input, Send, Retry x5, Enter-to-send, join/leave, the back link - and
// asserts REAL outcomes (message fan-out, sender identity, presence
// in/decrement, idempotent dedup, reload persistence, the FORBIDDEN denial),
// not a smoke check. The cross-replica cluster assertions live in the sibling
// demos-chat.cluster.spec.js (cluster tier, needs two instances).
//
// Rooms are shared Redis state capped at 100 and purged on a cron, so a
// unique room id per test keeps assertions unambiguous with no cleanup.

let roomSeq = 0
const freshRoom = (label) => `e2e-chat-${label}-${Date.now()}-${roomSeq++}`

async function presenceCount(page) {
	const raw = (await page.getByTestId('presence-count').textContent()) ?? ''
	return Number(raw.trim().split(' ')[0] || 0)
}

async function openRoom(page, room) {
	await page.goto(`/demos/chat/${room}`)
	await waitForWS(page)
}

test.describe('/demos/chat picker', () => {
	test('lists the three rooms with labels and descriptions', async ({ page }) => {
		await page.goto('/demos/chat')
		for (const id of ['general', 'random', 'private']) {
			await expect(page.getByTestId(`room-link-${id}`)).toBeVisible()
		}
		await expect(page.getByTestId('room-link-general')).toContainText('General')
		await expect(page.getByTestId('room-link-private')).toContainText('Members-only')
	})

	// A hover background shift was the only cue that the room cards were
	// navigable, and hover never fires on touch - so on a phone the lobby read
	// as three descriptions and the page's single required action had no
	// signifier at all. Asserted on a COARSE-POINTER context, because that is
	// the modality where the old cue was definitionally absent; a fine-pointer
	// check would pass on the hover style that was never the problem.
	test('every room card carries a visible door handle where hover never fires', async ({ browser }) => {
		const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } })
		const page = await context.newPage()
		try {
			await page.goto('/demos/chat')
			await waitForWS(page)
			for (const id of ['general', 'random', 'private']) {
				const signifier = page.getByTestId(`room-enter-${id}`)
				await expect(signifier).toBeVisible()
				// Inside the link, so it reads as part of the door rather than as
				// decoration parked beside it.
				await expect(page.getByTestId(`room-link-${id}`).getByTestId(`room-enter-${id}`)).toHaveCount(1)
			}
		} finally {
			await context.close()
		}
	})

	test('a room link navigates into the room surface', async ({ page }) => {
		await page.goto('/demos/chat')
		await page.getByTestId('room-link-general').click()
		await expect(page).toHaveURL(/\/demos\/chat\/general$/)
		await expect(page.getByTestId('messages')).toBeVisible()
	})
})

test.describe('/demos/chat/[roomId]', () => {
	test('private room denies the subscribe and disables every send affordance', async ({ page }) => {
		await page.goto('/demos/chat/private')
		await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByTestId('send-button')).toBeDisabled()
		await expect(page.getByTestId('retry-five-button')).toBeDisabled()
		await expect(page.getByTestId('message-input')).toBeDisabled()
		await expect(page.getByTestId('message-input')).toHaveAttribute('placeholder', /denied room/i)
	})

	test('a fresh room starts empty and reports one participant (self)', async ({ page }) => {
		await openRoom(page, freshRoom('empty'))
		await expect(page.getByTestId('messages')).toContainText(/No messages yet/i)
		await expect.poll(() => presenceCount(page), { timeout: 15_000 }).toBe(1)
	})

	test('Send is gated on a non-empty draft and posts a message with sender identity', async ({ page }) => {
		await openRoom(page, freshRoom('send'))

		// Empty draft: Send stays disabled.
		await expect(page.getByTestId('send-button')).toBeDisabled()

		const text = `hello-${Date.now()}`
		await page.getByTestId('message-input').fill(text)
		await expect(page.getByTestId('send-button')).toBeEnabled()
		await page.getByTestId('send-button').click()

		// The message lands exactly once, renders a non-empty sender name, and
		// the input clears. The aside surfaces the idempotency key that was used.
		const row = page.getByTestId('messages').locator('li', { hasText: text })
		await expect(row).toHaveCount(1, { timeout: 10_000 })
		await expect(row.locator('.font-semibold')).not.toBeEmpty()
		await expect(page.getByTestId('message-input')).toHaveValue('')
		await expect(page.locator('text=Last idempotencyKey:')).toBeVisible()
	})

	test('Enter submits the message', async ({ page }) => {
		await openRoom(page, freshRoom('enter'))
		const text = `enter-${Date.now()}`
		await page.getByTestId('message-input').fill(text)
		await page.getByTestId('message-input').press('Enter')
		await expect(page.getByTestId('messages').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })
	})

	test('two tabs in one room see each other messages and presence, both directions', async ({ browser }) => {
		test.setTimeout(60_000)
		const room = freshRoom('duplex')
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openRoom(a, room)
			await openRoom(b, room)

			// Both report two participants once both subscribes land.
			await expect.poll(() => presenceCount(a), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
			await expect.poll(() => presenceCount(b), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

			const fromA = `from-a-${Date.now()}`
			await a.getByTestId('message-input').fill(fromA)
			await a.getByTestId('send-button').click()
			await expect(a.getByTestId('messages')).toContainText(fromA, { timeout: 10_000 })
			await expect(b.getByTestId('messages')).toContainText(fromA, { timeout: 10_000 })

			const fromB = `from-b-${Date.now()}`
			await b.getByTestId('message-input').fill(fromB)
			await b.getByTestId('send-button').click()
			await expect(b.getByTestId('messages')).toContainText(fromB, { timeout: 10_000 })
			await expect(a.getByTestId('messages')).toContainText(fromB, { timeout: 10_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('presence decrements when a participant leaves', async ({ browser }) => {
		test.setTimeout(90_000)
		const room = freshRoom('leave')
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await openRoom(a, room)
			await openRoom(b, room)
			await expect.poll(() => presenceCount(a), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

			// B leaves. A's roster must shed the departed user, not leak it.
			await ctxB.close()
			await expect.poll(() => presenceCount(a), { timeout: 45_000 }).toBe(1)
		} finally {
			await ctxA.close()
			await ctxB.close().catch(() => {})
		}
	})

	test('Retry x5 with one idempotency key posts exactly one message', async ({ page }) => {
		await openRoom(page, freshRoom('retry'))
		const text = `retry-${Date.now()}`
		await page.getByTestId('message-input').fill(text)
		await page.getByTestId('retry-five-button').click()

		await expect(page.getByTestId('messages')).toContainText(text, { timeout: 10_000 })
		// Give any duplicate a chance to (wrongly) arrive before asserting once.
		await page.waitForTimeout(750)
		await expect(page.getByTestId('messages').locator('li', { hasText: text })).toHaveCount(1)
	})

	test('messages survive a reload (loader rehydrates from Redis)', async ({ page }) => {
		const room = freshRoom('persist')
		await openRoom(page, room)
		const text = `persist-${Date.now()}`
		await page.getByTestId('message-input').fill(text)
		await page.getByTestId('send-button').click()
		await expect(page.getByTestId('messages')).toContainText(text, { timeout: 10_000 })

		await page.reload()
		await waitForWS(page)
		await expect(page.getByTestId('messages').locator('li', { hasText: text })).toHaveCount(1, { timeout: 10_000 })
	})

	test('the Rooms back link returns to the picker', async ({ page }) => {
		await openRoom(page, freshRoom('back'))
		// Scope to the room header: the demos sidebar (an <aside>) also links to
		// /demos/chat, so an unscoped link locator would be ambiguous.
		await page.locator('header a[href="/demos/chat"]').click()
		await expect(page).toHaveURL(/\/demos\/chat$/)
		await expect(page.getByTestId('room-link-general')).toBeVisible()
	})
})
