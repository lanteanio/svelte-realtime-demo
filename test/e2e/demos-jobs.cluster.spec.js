import { test, expect } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'jobs cluster coverage requires two explicit replica targets')
test.describe.configure({ mode: 'serial' })

async function openAt(page, origin) {
	await page.goto(`${origin}/demos/jobs`)
	await waitForWS(page)
	// The cluster tier always provisions DATABASE_URL, so an unavailable card
	// here is a real defect - a dropped pool, a failed migration, a replica that
	// lost Postgres - not an unconfigured environment. Skipping on it would let
	// the whole file report green through exactly that failure. Only honour the
	// skip when the environment genuinely has no database configured.
	if (process.env.DATABASE_URL) {
		await expect(page.getByTestId('jobs-unavailable')).toHaveCount(0)
	} else if (await page.getByTestId('jobs-unavailable').isVisible().catch(() => false)) {
		test.skip(true, 'DATABASE_URL not configured; /demos/jobs requires Postgres')
	}
	await expect(page.getByTestId('jobs-enqueue-form')).toBeVisible()
}

async function clearJobs(page) {
	await confirmAndClick(page.getByTestId('jobs-clear-button'))
	await expect(page.getByTestId('jobs-list-empty')).toBeVisible({ timeout: 5_000 })
	await expect(page.getByTestId('stat-total')).toHaveText('0')
}

async function enqueue(page, duration = 0.4) {
	await page.getByTestId('jobs-duration-input').fill(String(duration))
	await page.getByTestId('jobs-duration-input').dispatchEvent('change')
	await page.getByTestId('jobs-mode-input').selectOption('succeed')
	await page.getByTestId('jobs-enqueue-button').click()
}

test.describe('cluster: /demos/jobs', () => {
	test('enqueue and completion on replica A propagate to B; a clear on B propagates to A', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await clearJobs(a)
			await expect(b.getByTestId('jobs-list-empty')).toBeVisible()
			await enqueue(a)
			for (const page of [a, b]) {
				const row = page.getByTestId('jobs-row').first()
				await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 12_000 })
				await expect(row.getByTestId('jobs-row-result')).toHaveText(/attempt 1/)
				await expect(page.getByTestId('stat-committed')).toHaveText('1')
				await expect(page.getByTestId('stat-total')).toHaveText('1')
			}
			await clearJobs(b)
			await expect(a.getByTestId('jobs-list-empty')).toBeVisible({ timeout: 5_000 })
			await expect(a.getByTestId('stat-total')).toHaveText('0')
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})

	test('replica B can force-take over replica A work and both converge on the retried commit', async ({ browser }) => {
		test.setTimeout(35_000)
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A })
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B })
		const a = await ctxA.newPage()
		const b = await ctxB.newPage()
		try {
			await Promise.all([openAt(a, INSTANCE_A), openAt(b, INSTANCE_B)])
			await clearJobs(a)
			await enqueue(a, 4)
			const remoteRow = b.getByTestId('jobs-row').first()
			await expect(remoteRow).toHaveAttribute('data-status', 'running', { timeout: 8_000 })
			await remoteRow.getByTestId('jobs-row-takeover').click()
			for (const page of [a, b]) {
				const row = page.getByTestId('jobs-row').first()
				await expect(row).toHaveAttribute('data-status', 'committed', { timeout: 22_000 })
				await expect(row.getByTestId('jobs-row-result')).toHaveText(/attempt [2-9]/)
				await expect(page.getByTestId('stat-total')).toHaveText('1')
			}
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()])
		}
	})
})
