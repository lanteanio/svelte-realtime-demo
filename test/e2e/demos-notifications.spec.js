import { test, expect } from '@playwright/test'
import { expectTouchTarget, openTouchPage, waitForWS } from './helpers.js'

// Exhaustive human-like coverage for /demos/notifications - live.push
// request/reply, a global scheduled queue drained by a 6-field live.cron,
// and a capped activity log. Drives every interactive element (recipient
// select, schedule slider, text input, send, the two inbox ack buttons,
// scheduled cancel) and asserts REAL outcomes: the SEND AWAITS the
// recipient's reply (in-flight "Sending..." with no premature outcome),
// the exact outcome per reply (delivered / dismissed), the 8s push
// timeout branch, the scheduled-queue stream fanning out to both tabs
// with a live countdown, the cron draining it into the recipient's inbox,
// cancel before fire, and the activity log recording each kind. The
// "alone" state (recipient select disabled) lives in the isolated
// project. Cross-replica behaviour (registry-routed push + cluster
// -singleton cron) lives in the .cluster.spec.js sibling.
//
// The scheduled queue and activity log are GLOBAL shared Redis state, so
// every test tags its message with a unique RUN token and filters by it
// (workers=1 serial; per-tier FLUSHDB gives a clean start).

const RUN = `e2e-${Date.now()}`

async function open(page) {
	await page.goto('/demos/notifications')
	await waitForWS(page)
}

/**
 * Read the page's `data-testid="my-id"` element and return the full user
 * id from its `data-user-id` attribute. The page renders only the first 8
 * chars visually; the full id is needed to selectOption(bId) deterministically
 * against the recipient dropdown - relying on the pre-selected first option is
 * flaky when other identities (parallel contexts) also sit in global presence.
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
		// Achievable against a freshly-started localhost dev server with no
		// other tabs open; not achievable against the public demo, where real
		// users and continuous background traffic keep presence populated.
		test.skip(
			!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(baseURL ?? ''),
			'alone semantics require localhost dev server (no real-user presence)'
		)
		await open(page)
		// Single context = no other users in global presence.
		await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 5_000 })
		// Recipient select is disabled and shows the no-users placeholder.
		await expect(page.getByTestId('recipient-select')).toBeDisabled()
		await expect(page.getByTestId('recipient-select')).toContainText('No other users online')
		// Send is disabled: no recipient and no text.
		await expect(page.getByTestId('send-button')).toBeDisabled()
		// The queue starts empty.
		await expect(page.getByTestId('scheduled-empty')).toBeVisible()
	})

	test('send controls gate on recipient presence, message text, and the schedule slider', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const aId = await getMyId(a)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// You are never your own recipient (the list filters out self).
			await expect(a.getByTestId(`recipient-option-${aId}`)).toHaveCount(0)

			// A recipient exists but there is no text yet -> Send stays disabled.
			await expect(a.getByTestId('text-input')).toHaveValue('')
			await expect(a.getByTestId('send-button')).toBeDisabled()

			// Real text enables it; at schedule 0 the button reads "Send".
			await a.getByTestId('text-input').fill(`gate-${RUN}`)
			await expect(a.getByTestId('send-button')).toBeEnabled()
			await expect(a.getByTestId('send-button')).toHaveText('Send')

			// Whitespace-only text re-disables it (the client pre-empts the
			// server's `text required` VALIDATION).
			await a.getByTestId('text-input').fill('   ')
			await expect(a.getByTestId('send-button')).toBeDisabled()

			// Back to real text, then the slider flips the button into schedule
			// mode and back - the label tracks the slider value live.
			await a.getByTestId('text-input').fill(`gate-${RUN}`)
			await expect(a.getByTestId('send-button')).toBeEnabled()
			await a.getByTestId('schedule-input').fill('5')
			await expect(a.getByTestId('send-button')).toHaveText('Schedule (5s)')
			// The slider states its domain before anyone drags to find it,
			// and the message field is labeled like its two siblings.
			await expect(a.getByText('Schedule (5s of 30s max)')).toBeVisible()
			await expect(a.locator('label', { has: a.getByTestId('text-input') }).locator('span').first()).toHaveText('Message')
			await a.getByTestId('schedule-input').fill('0')
			await expect(a.getByTestId('send-button')).toHaveText('Send')

			// Clearing the text disables Send again even with a valid recipient.
			await a.getByTestId('text-input').fill('')
			await expect(a.getByTestId('send-button')).toBeDisabled()
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('happy path: the send awaits B\'s reply; Got it -> delivered, card clears, activity logs it', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `hi-${RUN}-happy`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			// The card lands in B's inbox with the exact text...
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })
			await expect(inboxCard.getByTestId('inbox-card-text')).toHaveText(text)

			// ...and the send is genuinely AWAITING B's reply: A's button is
			// stuck on "Sending..." and no outcome banner has appeared yet.
			// (Not optimistic - the outcome is the server-returned reply value.)
			await expect(a.getByTestId('send-button')).toHaveText('Sending...')
			await expect(a.getByTestId('outcome')).toHaveCount(0)
			// The wait announces itself and counts the reply window down.
			await expect(a.getByTestId('push-wait')).toContainText('waiting for')
			await expect(a.getByTestId('push-wait')).toContainText('s left')

			// B clicks Got it; the reply value travels back as A's outcome.
			await inboxCard.getByTestId('inbox-ack-ok').click()
			await expect(a.getByTestId('outcome-kind')).toHaveText('delivered', { timeout: 8_000 })
			await expect(a.getByTestId('push-wait')).toHaveCount(0)
			// The activity entry names the worker that handled it - the
			// cluster-wiring surface this page was missing.
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first().getByTestId('activity-instance')).toHaveText(/^on \S+$/, { timeout: 8_000 })

			// Card cleared from B's inbox; the text input was reset on success.
			await expect(inboxCard).toHaveCount(0)
			await expect(a.getByTestId('text-input')).toHaveValue('')

			// Both tabs' activity logs record a delivered entry for this text.
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('delivered', { timeout: 8_000 })
			await expect(b.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('delivered', { timeout: 8_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('dismiss path: Dismiss -> A sees dismissed and the activity log agrees', async ({ browser }) => {
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `hi-${RUN}-dismiss`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })
			await inboxCard.getByTestId('inbox-ack-dismiss').click()

			await expect(a.getByTestId('outcome-kind')).toHaveText('dismissed', { timeout: 8_000 })
			await expect(inboxCard).toHaveCount(0)
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('dismissed', { timeout: 8_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('timeout: B gets the card but never replies; A resolves timed out after the 8s window', async ({ browser }) => {
		test.setTimeout(30_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			const text = `to-${RUN}`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('send-button').click()

			// B receives the card but deliberately does NOT ack it.
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 8_000 })

			// After the 8s push timeout the send resolves as timed out - this
			// is the real server-side PUSH_TIMEOUT_MS branch, not a client guess.
			await expect(a.getByTestId('outcome-kind')).toHaveText('timed out', { timeout: 15_000 })
			// The un-acked card is still sitting in B's inbox (the recipient's
			// promise never resolved; only the sender's await timed out).
			await expect(inboxCard).toBeVisible()
			// Activity records the timeout for this text.
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('timed out', { timeout: 8_000 })
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('schedule + fire: both tabs see the queued entry with a countdown; the cron drains it into B\'s inbox', async ({ browser }) => {
		test.setTimeout(30_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// Schedule 5s out: a comfortable window to observe the entry on
			// both tabs before the cron drains it, still fast overall.
			const text = `sched-${RUN}-fire`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('schedule-input').fill('5')
			await expect(a.getByTestId('send-button')).toHaveText('Schedule (5s)')
			await a.getByTestId('send-button').click()

			// The outcome banner reports scheduled (not delivered).
			await expect(a.getByTestId('outcome-kind')).toHaveText('scheduled', { timeout: 5_000 })

			// The queue stream fans out to BOTH tabs, with a live "in Ns" badge.
			const aItem = a.getByTestId('scheduled-item').filter({ hasText: text })
			const bItem = b.getByTestId('scheduled-item').filter({ hasText: text })
			await expect(aItem).toBeVisible({ timeout: 5_000 })
			await expect(bItem).toBeVisible({ timeout: 5_000 })
			await expect(aItem).toContainText(/in \d+s/)

			// The 1Hz cron tick drains the due entry: B's inbox gets the card,
			// the queue drops it on both tabs, and activity logs a 'fired' event.
			const inboxCard = b.getByTestId('inbox-card').filter({ hasText: text })
			await expect(inboxCard).toBeVisible({ timeout: 10_000 })
			await expect(aItem).toHaveCount(0, { timeout: 5_000 })
			await expect(bItem).toHaveCount(0)
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('fired', { timeout: 8_000 })

			// Cleanup: B acks so the fired push resolves rather than timing out.
			await inboxCard.getByTestId('inbox-ack-ok').click()
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('schedule + cancel: cancel before fire removes the entry on both tabs; activity shows cancelled, no card fires', async ({ browser }) => {
		test.setTimeout(30_000)
		const ctxA = await browser.newContext()
		const ctxB = await browser.newContext()
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await open(a)
			await open(b)
			const bId = await getMyId(b)
			await selectRecipient(a, bId)

			// Schedule far enough out that we have time to cancel it.
			const text = `sched-${RUN}-cancel`
			await a.getByTestId('text-input').fill(text)
			await a.getByTestId('schedule-input').fill('30')
			await a.getByTestId('send-button').click()
			await expect(a.getByTestId('outcome-kind')).toHaveText('scheduled', { timeout: 5_000 })

			const aItem = a.getByTestId('scheduled-item').filter({ hasText: text })
			const bItem = b.getByTestId('scheduled-item').filter({ hasText: text })
			await expect(aItem).toBeVisible({ timeout: 5_000 })
			await expect(bItem).toBeVisible({ timeout: 5_000 })

			// Cancel is the row's only, time-critical action: real button
			// chrome at ack-button size, not ghost btn-xs.
			await expect(aItem.getByRole('button', { name: 'Cancel' })).toHaveClass(/btn-outline/)
			await expect(aItem.getByRole('button', { name: 'Cancel' })).toHaveClass(/btn-sm/)

			// Cancel from A; the deletion fans out to B too.
			await aItem.getByRole('button', { name: 'Cancel' }).click()
			await expect(aItem).toHaveCount(0, { timeout: 5_000 })
			await expect(bItem).toHaveCount(0, { timeout: 5_000 })

			// Activity records a cancelled entry for this text.
			await expect(a.getByTestId('activity-item').filter({ hasText: text }).first())
				.toContainText('cancelled', { timeout: 5_000 })

			// No card ever fires: wait past a couple of cron ticks and confirm
			// B's inbox stayed empty for this text.
			await a.waitForTimeout(2_500)
			await expect(b.getByTestId('inbox-card').filter({ hasText: text })).toHaveCount(0)
		} finally {
			await ctxA.close()
			await ctxB.close()
		}
	})

	test('primary controls meet the 44px floor on a coarse-pointer rung', async ({ browser }) => {
		const { context, page } = await openTouchPage(browser)
		try {
			await open(page)
			await expectTouchTarget(page.getByTestId('text-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('send-button'))
			await expectTouchTarget(page.getByTestId('schedule-input'), { minWidth: 0 })
			await expectTouchTarget(page.getByTestId('schedule-dec'))
			await expectTouchTarget(page.getByTestId('schedule-inc'))
			// Exact-value precision: stepper taps move the schedule by exactly one
			// second - asserted off the default so a stale 0 cannot pass vacuously.
			await page.getByTestId('schedule-inc').tap()
			await page.getByTestId('schedule-inc').tap()
			await expect(page.getByTestId('schedule-input')).toHaveValue('2')
			await page.getByTestId('schedule-dec').tap()
			await expect(page.getByTestId('schedule-input')).toHaveValue('1')
		} finally {
			await context.close()
		}
	})
})
