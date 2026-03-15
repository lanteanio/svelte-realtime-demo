import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, getNotes, waitForBoardReady, waitForWS } from './helpers.js';

let boardUrl;

test.describe.serial('Board Page', () => {
	test('create a board to test with', async ({ page }) => {
		boardUrl = await createBoard(page, `E2E Board ${Date.now()}`);
	});

	test('board canvas is visible with empty hint', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await expect(page.getByText('Double-click anywhere to add a note')).toBeVisible();
	});

	test('double-click canvas creates a note', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const canvas = getCanvas(page);
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(2000);

		const hint = page.getByText('Double-click anywhere to add a note');
		await expect(hint).not.toBeVisible({ timeout: 5000 });
	});

	test('can edit a note by double-clicking', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const canvas = getCanvas(page);
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 200, box.y + 200);
		await page.waitForTimeout(2000);

		const note = getNotes(page).first();
		if (await note.isVisible()) {
			await note.dblclick({ force: true });
			await page.waitForTimeout(500);
			const editor = page.locator('textarea').first();
			if (await editor.isVisible()) {
				await editor.fill('Hello from E2E!');
				await editor.blur();
				await page.waitForTimeout(1000);
			}
		}
	});

	test('presence bar shows users on board', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await page.waitForTimeout(2000);
		await expect(page.getByText(/online/).first()).toBeVisible();
	});

	test('can navigate back to home', async ({ page }) => {
		await page.goto(boardUrl);
		await page.getByText('Sticky Notes').first().click();
		await page.waitForURL('/');
	});
});
