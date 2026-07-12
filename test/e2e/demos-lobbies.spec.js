import { test, expect } from '@playwright/test'
import { waitForWS } from './helpers.js'

test.describe('/demos/lobbies', () => {
	async function openLobbies(page) {
		await page.goto('/demos/lobbies')
		await waitForWS(page)
	}

	/** Random numeric id so runs never collide on a shared cluster. */
	function freshTableId() {
		return String(100000 + Math.floor(Math.random() * 900000))
	}

	test('create a table, chat, and see it enumerated with a share code', async ({ page }) => {
		await openLobbies(page)
		const id = freshTableId()

		await page.getByTestId('lob-new-id').fill(id)
		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`)

		// Send a message; the crud feed renders it.
		await page.getByTestId('lob-composer-input').fill('hello table')
		await page.getByTestId('lob-send').click()
		await expect(page.getByTestId('lob-feed')).toContainText('hello table', { timeout: 10_000 })

		// The lobby browser lists the table: live count >= 1 (us) and a
		// 6-char Base62 share code from the meta card.
		const row = page.getByTestId(`lob-room-${id}`)
		await expect(row).toBeVisible({ timeout: 10_000 })
		const countText = await row.getByTestId('lob-room-count').textContent()
		expect(Number(countText?.match(/^(\d+)/)?.[1] ?? 0)).toBeGreaterThanOrEqual(1)
		const code = (await row.getByTestId('lob-room-code').textContent())?.trim()
		expect(code).toMatch(/^[0-9A-Za-z]{6}$/)
	})

	test('join by code resolves back to the same table', async ({ page }) => {
		await openLobbies(page)
		const id = freshTableId()

		await page.getByTestId('lob-new-id').fill(id)
		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`)

		const row = page.getByTestId(`lob-room-${id}`)
		await expect(row).toBeVisible({ timeout: 10_000 })
		const code = (await row.getByTestId('lob-room-code').textContent())?.trim() ?? ''
		expect(code).toMatch(/^[0-9A-Za-z]{6}$/)

		// Leave, then come back purely through the share code: decode runs
		// server-side (the secret never ships to the client).
		await page.getByTestId('lob-leave').click()
		await expect(page.getByTestId('lob-table-title')).not.toBeVisible()

		await page.getByTestId('lob-code-input').fill(code)
		await page.getByTestId('lob-code-join').click()
		await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`, { timeout: 10_000 })
	})

	test('first joiner claims the owner role and may close the table', async ({ page }) => {
		await openLobbies(page)
		const id = freshTableId()

		await page.getByTestId('lob-new-id').fill(id)
		await page.getByTestId('lob-create').click()
		await expect(page.getByTestId('lob-table-title')).toHaveText(`Table ${id}`)

		// First member claims ownership; the badge reflects the live
		// owner sub-stream compared against the identity cookie id.
		await expect(page.getByTestId('lob-owner-badge')).toHaveText(/you own this table/i, { timeout: 10_000 })

		// closeTable is ownerOnly - as owner it succeeds and wipes the feed.
		await page.getByTestId('lob-composer-input').fill('to be wiped')
		await page.getByTestId('lob-send').click()
		await expect(page.getByTestId('lob-feed')).toContainText('to be wiped', { timeout: 10_000 })

		const closeButton = page.getByTestId('lob-close')
		await expect(closeButton).toBeEnabled({ timeout: 10_000 })
		await closeButton.click()
		await expect(page.getByTestId('lob-feed')).not.toContainText('to be wiped', { timeout: 10_000 })
	})
})
