import { test, expect } from '@playwright/test'

async function gotoFreshJobs(page) {
	await page.goto('/demos/jobs')
	// Skip the entire suite if Postgres isn't wired (the page will show
	// the unavailable banner instead of the form). The deployable subset
	// runs against a server with DATABASE_URL set; bare in-memory dev
	// would be a separate run.
	const unavailable = page.getByTestId('jobs-unavailable')
	if (await unavailable.isVisible().catch(() => false)) {
		test.skip(true, 'DATABASE_URL not configured; /demos/jobs requires Postgres')
	}
	// Clear any rows from prior tests so the recent-list selector is
	// unambiguous (each test exercises exactly one row).
	await page.getByTestId('jobs-clear-button').click()
	await expect(page.getByTestId('jobs-list-empty')).toBeVisible({ timeout: 5_000 })
}

async function setDuration(page, seconds) {
	const slider = page.getByTestId('jobs-duration-input')
	await slider.fill(String(seconds))
	await slider.dispatchEvent('change')
}

test.describe('/demos/jobs', () => {
	test('renders stats strip, enqueue form, and recent-tasks list', async ({ page }) => {
		await gotoFreshJobs(page)
		await expect(page.getByTestId('jobs-stats-strip')).toBeVisible()
		await expect(page.getByTestId('jobs-enqueue-form')).toBeVisible()
		await expect(page.getByTestId('jobs-list')).toBeVisible()
		await expect(page.getByTestId('jobs-duration-input')).toBeVisible()
		await expect(page.getByTestId('jobs-mode-input')).toBeVisible()
		await expect(page.getByTestId('jobs-enqueue-button')).toBeVisible()
	})

	test('happy path: enqueued task transitions pending -> running -> committed', async ({ page }) => {
		await gotoFreshJobs(page)
		await setDuration(page, 0.6)
		await page.getByTestId('jobs-mode-input').selectOption('succeed')
		await page.getByTestId('jobs-enqueue-button').click()

		// Row appears within ~2s (RPC publishes synchronously; cron tick
		// is the fallback path).
		await expect(page.getByTestId('jobs-row').first()).toBeVisible({ timeout: 8_000 })

		// Within ~6s we should reach committed: dispatch sweep ~1s + run
		// ~0.6s + cron-driven page refresh ~1s leaves ample slack.
		const row = page.getByTestId('jobs-row').first()
		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 10_000 })
		await expect(page.getByTestId('jobs-row-result').first()).toBeVisible()
	})

	test('retry policy: fail-once task lands at committed on attempt 2', async ({ page }) => {
		await gotoFreshJobs(page)
		await setDuration(page, 0.6)
		await page.getByTestId('jobs-mode-input').selectOption('fail-once')
		await page.getByTestId('jobs-enqueue-button').click()

		// First attempt throws; runner retries; second attempt commits.
		// 0.6s * 2 attempts + 250ms backoff + ~2s polling slack ~= 4s,
		// budget 14s for CI noise.
		const row = page.getByTestId('jobs-row').first()
		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 14_000 })

		// The result block records which attempt actually committed; for
		// fail-once that should be attempt 2 (or higher if a takeover
		// also fired, which it doesn't here).
		const resultText = await page.getByTestId('jobs-row-result').first().textContent()
		expect(resultText).toMatch(/attempt\s+[2-3]/)
	})

	test('force takeover: a running task aborts and re-runs to committed', async ({ page }) => {
		await gotoFreshJobs(page)
		// 4s window: long enough that we can catch the row mid-running and
		// hit Force takeover before it would have committed on attempt 1.
		await setDuration(page, 4)
		await page.getByTestId('jobs-mode-input').selectOption('succeed')
		await page.getByTestId('jobs-enqueue-button').click()

		const row = page.getByTestId('jobs-row').first()
		await expect(row).toHaveAttribute('data-status', 'running', { timeout: 8_000 })

		// Click takeover. Recovery sweep claims with new fence within
		// ~2s; the original handler's heartbeat aborts via signal; the
		// retry policy queues attempt 2; attempt 2 runs 4s and commits.
		await page.getByTestId('jobs-row-takeover').first().click()

		await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 18_000 })
		const resultText = await page.getByTestId('jobs-row-result').first().textContent()
		expect(resultText).toMatch(/attempt\s+[2-9]/)
	})
})
