import { test, expect } from '@playwright/test'

const RUN = `e2e-${Date.now()}`

/**
 * Read the page's `data-testid="my-id"` element and return the full user id
 * from its `data-user-id` attribute. The page only renders the first 8 chars
 * visually; the full id is required so A can selectOption(bId) deterministically
 * against the recipient dropdown - relying on the pre-selected first option
 * is flaky when parallel test workers contribute other identities to global
 * presence.
 */
async function getMyId(page) {
	return await page.getByTestId('my-id').getAttribute('data-user-id')
}

/**
 * A picks B explicitly from A's recipient dropdown. Waits for B's option to
 * appear (presence fan-out is async) before selecting, so the test does not
 * race the option-list render.
 */
async function selectRecipient(a, bId) {
	const option = a.getByTestId(`recipient-option-${bId}`)
	await expect(option).toBeAttached({ timeout: 10_000 })
	await a.getByTestId('recipient-select').selectOption(bId)
}

test.describe('/demos/notifications', () => {
	test('alone on the page: recipient dropdown shows the no-users state and Send is disabled', async ({ page, baseURL }) => {
		// "Alone" requires zero entries in the global presence channel.
		// Achievable against a freshly-started localhost dev server with
		// no other tabs open; not achievable against the public demo,
		// where real users and continuous background traffic keep
		// presence populated. Skip when BASE_URL points at a public host.
		test.skip(
			!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseURL ?? ''),
			'alone semantics require localhost dev server (no real-user presence)'
		)
		await page.goto('/demos/notifications')
		// Single context = no other users in global presence.
		await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 5_000 })
		// Recipient select is disabled when nobody else is online.
		await expect(page.getByTestId('recipient-select')).toBeDisabled()
		// Send button is disabled until there's a recipient + text.
		await expect(page.getByTestId('send-button')).toBeDisabled()
	})

	test('happy path: A pushes to B, B clicks Got it, A sees delivered', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/notifications')
			await b.goto('/demos/notifications')

			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `hi-${RUN}-happy`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			// Card lands in B's inbox with the right text.
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })

			// B acks with Got it.
			await inboxCard.getByTestId('inbox-ack-ok').click()

			// A's outcome banner reports delivered.
			await expect(a.getByTestId('outcome-kind')).toHaveText('delivered', { timeout: 8_000 })

			// Card cleared from B's inbox.
			await expect(inboxCard).toHaveCount(0)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('dismiss path: B clicks Dismiss, A sees dismissed', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/notifications')
			await b.goto('/demos/notifications')

			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `hi-${RUN}-dismiss`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })
			await inboxCard.getByTestId('inbox-ack-dismiss').click()

			await expect(a.getByTestId('outcome-kind')).toHaveText('dismissed', { timeout: 8_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('schedule + fire: cron tick drains the queue, B sees the card', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/notifications')
			await b.goto('/demos/notifications')

			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// Schedule 2 seconds out - short enough to keep the test fast,
			// long enough to assert the entry sits in the queue first.
			const text = `sched-${RUN}-fire`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('schedule-input').fill('2')
			await a.getByTestId('send-button').click()

			// Outcome banner reports scheduled.
			await expect(a.getByTestId('outcome-kind')).toHaveText('scheduled', { timeout: 5_000 })

			// Both tabs see the entry in the scheduled list.
			const scheduledItem = a.getByTestId('scheduled-item').filter({ hasText: text })
			await expect(scheduledItem).toBeVisible({ timeout: 5_000 })

			// Within ~5s the cron tick fires and B's inbox shows the card.
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })

			// And the scheduled list has dropped the entry.
			await expect(scheduledItem).toHaveCount(0)

			// Clean up B's inbox so the next test starts clean.
			await inboxCard.getByTestId('inbox-ack-ok').click()
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('schedule + cancel: cancel removes the entry before fire, activity log shows cancelled', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await a.goto('/demos/notifications')
			await b.goto('/demos/notifications')

			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// Long-enough schedule that we have time to cancel.
			const text = `sched-${RUN}-cancel`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('schedule-input').fill('30')
			await a.getByTestId('send-button').click()

			const scheduledItem = a.getByTestId('scheduled-item').filter({ hasText: text })
			await expect(scheduledItem).toBeVisible({ timeout: 5_000 })

			// Cancel via the inline button.
			await scheduledItem.getByRole('button', { name: 'Cancel' }).click()

			// Item gone from the list.
			await expect(scheduledItem).toHaveCount(0, { timeout: 5_000 })

			// Activity log shows a cancelled entry for our text.
			const activityCancelled = a.getByTestId('activity-item').filter({ hasText: text })
			await expect(activityCancelled.first()).toContainText('cancelled', { timeout: 5_000 })

			// And B's inbox never received a card for this text (no fire happened).
			await expect(b.getByTestId('inbox-card').filter({ hasText: text })).toHaveCount(0)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})
})
