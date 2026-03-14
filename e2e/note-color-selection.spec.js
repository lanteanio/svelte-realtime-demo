import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, getNotes, waitForBoardReady } from './helpers.js';

test.describe('Default Note Color Selection', () => {
	test('navbar shows 6 color circles', async ({ page }) => {
		await page.goto('/');
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		expect(await colorButtons.count()).toBe(6);
	});

	test('first color is selected by default (has border-primary)', async ({ page }) => {
		await page.goto('/');
		const firstColor = page.locator('.navbar button[aria-label="Set default note color"]').first();
		const classes = await firstColor.getAttribute('class');
		expect(classes).toContain('border-primary');
	});

	test('clicking a different color updates selection', async ({ page }) => {
		await page.goto('/');
		// Click the 3rd color (blue #bfdbfe)
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		await colorButtons.nth(2).click();
		await page.waitForTimeout(300);

		const classes = await colorButtons.nth(2).getAttribute('class');
		expect(classes).toContain('border-primary');

		// First color should no longer be selected
		const firstClasses = await colorButtons.nth(0).getAttribute('class');
		expect(firstClasses).not.toContain('border-primary');
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

		// The note should have the green background
		const note = getNotes(page).first();
		const bg = await note.evaluate((el) => el.style.background);
		expect(bg).toContain('bbf7d0');
	});

	test('color selection persists via localStorage', async ({ page }) => {
		await page.goto('/');

		// Select pink (#fbcfe8) — the 4th color
		const colorButtons = page.locator('.navbar button[aria-label="Set default note color"]');
		await colorButtons.nth(3).click();
		await page.waitForTimeout(300);

		// Check localStorage
		const stored = await page.evaluate(() => localStorage.getItem('noteColor'));
		expect(stored).toBe('#fbcfe8');

		// Refresh — should still be selected
		await page.reload();
		await page.waitForTimeout(1000);
		const classes = await colorButtons.nth(3).getAttribute('class');
		expect(classes).toContain('border-primary');
	});
});
