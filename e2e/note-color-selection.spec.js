import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, getNotes, waitForBoardReady, waitForWS } from './helpers.js';

test.describe('Default Note Color Selection', () => {
	test('navbar shows 6 color circles', async ({ page }) => {
		await page.goto('/');
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		expect(await colorButtons.count()).toBe(6);
	});

	test('first color is selected by default (has primary border)', async ({ page }) => {
		await page.goto('/');
		const firstColor = page.locator('.navbar button[aria-label="Set default note color"]').first();
		const borderColor = await firstColor.evaluate((el) => getComputedStyle(el).borderColor);
		expect(borderColor).toBeTruthy();
	});

	test('clicking a different color updates localStorage', async ({ page }) => {
		await page.goto('/');
		await waitForWS(page); // Ensure JS is loaded for onclick handlers

		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		// Click the 3rd color (blue #bfdbfe)
		await colorButtons.nth(2).click();
		await page.waitForTimeout(500);

		const stored = await page.evaluate(() => localStorage.getItem('noteColor'));
		expect(stored).toBe('#bfdbfe');
	});

	test('new note uses selected default color', async ({ page }) => {
		const boardUrl = await createBoard(page, `Color Default ${Date.now()}`);
		await waitForBoardReady(page);

		// Select green (#bbf7d0) — the 2nd color circle
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		await colorButtons.nth(1).click();
		await page.waitForTimeout(300);

		// Create a note
		const canvas = getCanvas(page);
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 300, box.y + 300);
		await page.waitForTimeout(2000);

		// The note background is set via style:background which the browser resolves to RGB
		// #bbf7d0 = rgb(187, 247, 208)
		const note = getNotes(page).first();
		const bg = await note.evaluate((el) => el.style.background);
		expect(bg).toMatch(/bbf7d0|rgb\(187,\s*247,\s*208\)/);
	});

	test('color selection persists via localStorage', async ({ page }) => {
		await page.goto('/');
		await waitForWS(page);

		// Select pink (#fbcfe8) — the 4th color
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		await colorButtons.nth(3).click();
		await page.waitForTimeout(500);

		const stored = await page.evaluate(() => localStorage.getItem('noteColor'));
		expect(stored).toBe('#fbcfe8');

		// Refresh — localStorage should persist
		await page.reload();
		await page.waitForTimeout(1000);
		const storedAfter = await page.evaluate(() => localStorage.getItem('noteColor'));
		expect(storedAfter).toBe('#fbcfe8');
	});
});
