import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, waitForBoardReady } from './helpers.js';

let boardUrl;

test.describe.serial('Board Settings', () => {
	test('setup: create a board', async ({ page }) => {
		boardUrl = await createBoard(page, `Settings Test ${Date.now()}`);
	});

	test('board title is displayed in header', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await expect(page.locator('h1')).toBeVisible();
		const title = await page.locator('h1').textContent();
		expect(title).toContain('Settings Test');
	});

	test('double-click title opens edit input', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.locator('h1').dblclick();
		await expect(page.locator('input.input.input-sm')).toBeVisible();
	});

	test('editing title and pressing Enter saves it', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.locator('h1').dblclick();

		const input = page.locator('input.input.input-sm');
		await input.fill('Renamed Board');
		await input.press('Enter');
		await page.waitForTimeout(1500);

		await expect(page.locator('h1')).toHaveText('Renamed Board');
	});

	test('title persists after refresh', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await expect(page.locator('h1')).toHaveText('Renamed Board');
	});

	test('background color buttons are visible', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		const bgButtons = page.getByLabel(/Set background to #/);
		expect(await bgButtons.count()).toBe(6);
	});

	test('clicking background color changes canvas background', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const canvas = getCanvas(page);
		const bgBefore = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);

		// Click the yellow background (#fefce8)
		await page.getByLabel('Set background to #fefce8').click();
		await page.waitForTimeout(1500);

		const bgAfter = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bgAfter).not.toBe(bgBefore);
	});

	test('background persists after refresh', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.waitForTimeout(1000);

		const canvas = getCanvas(page);
		const bg = await canvas.evaluate((el) => getComputedStyle(el).backgroundColor);
		// Default is #f5f5f4 = rgb(245, 245, 244), yellow is #fefce8 = rgb(254, 252, 232)
		expect(bg).not.toBe('rgb(245, 245, 244)');
	});
});
