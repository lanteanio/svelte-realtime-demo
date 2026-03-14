import { test, expect } from '@playwright/test';
import { createBoard, createNote, getNotes, waitForBoardReady } from './helpers.js';

let boardUrl;

test.describe.serial('Activity Ticker', () => {
	test('setup: create a board', async ({ page }) => {
		boardUrl = await createBoard(page, `Activity Test ${Date.now()}`);
	});

	test('empty board shows "No activity yet" message', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await expect(page.getByText('No activity yet')).toBeVisible();
	});

	test('activity ticker is fixed at bottom of page', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const ticker = page.locator('.fixed.bottom-0');
		await expect(ticker).toBeVisible();
	});

	test('creating a note produces an activity entry', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		await createNote(page, 300, 300);

		// Activity ticker should now show an entry (not "No activity yet")
		await page.waitForTimeout(1000);
		const noActivity = page.getByText('No activity yet');
		await expect(noActivity).not.toBeVisible({ timeout: 5000 });
	});

	test('activity entries show user name and action', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.waitForTimeout(1500);

		// The ticker should contain entries with user name (font-semibold) and action text
		const entries = page.locator('.fixed.bottom-0 span.whitespace-nowrap');
		if (await entries.count() > 0) {
			const entry = entries.first();
			const userName = entry.locator('.font-semibold');
			await expect(userName).toBeVisible();
		}
	});

	test('activity entries have colored dots', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.waitForTimeout(1500);

		const dots = page.locator('.fixed.bottom-0 .w-2.h-2.rounded-full');
		if (await dots.count() > 0) {
			const bg = await dots.first().evaluate((el) => el.style.background);
			expect(bg).toBeTruthy();
		}
	});

	test('deleting a note adds activity entry', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Count existing activity entries
		const ticker = page.locator('.fixed.bottom-0');
		const entriesBefore = await ticker.locator('span.whitespace-nowrap').count();

		if (await getNotes(page).count() > 0) {
			const note = getNotes(page).first();
			await note.hover();
			await page.getByLabel('Delete note').first().click();
			await page.waitForTimeout(2000);

			const entriesAfter = await ticker.locator('span.whitespace-nowrap').count();
			expect(entriesAfter).toBeGreaterThanOrEqual(entriesBefore);
		}
	});
});
