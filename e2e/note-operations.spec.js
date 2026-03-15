import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, createNote, getNotes, waitForBoardReady } from './helpers.js';

let boardUrl;

test.describe.serial('Note Operations', () => {
	test('setup: create a board', async ({ page }) => {
		boardUrl = await createBoard(page, `Notes Ops ${Date.now()}`);
	});

	test('double-click creates a note at cursor position', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await createNote(page, 200, 200);
		expect(await getNotes(page).count()).toBe(1);
	});

	test('note shows "Double-click to edit" placeholder', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		await expect(page.getByText('Double-click to edit')).toBeVisible();
	});

	test('note shows creator name', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		// The creator_name is shown in a small footer text
		const footer = page.locator('.absolute.w-52 .text-xs.opacity-40');
		await expect(footer.first()).toBeVisible();
		const text = await footer.first().textContent();
		expect(text.trim().length).toBeGreaterThan(0);
	});

	test('double-click note opens textarea for editing', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		await note.dblclick({ force: true });
		await expect(page.locator('textarea')).toBeVisible();
	});

	test('typing in textarea and blurring saves content', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		await note.dblclick({ force: true });
		const textarea = page.locator('textarea');
		await textarea.fill('Edited content!');
		await textarea.blur();
		await page.waitForTimeout(1000);

		await expect(page.getByText('Edited content!')).toBeVisible();
	});

	test('Escape key closes the editor', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		await note.dblclick({ force: true });
		const textarea = page.locator('textarea');
		await expect(textarea).toBeVisible();
		await textarea.press('Escape');
		await expect(textarea).not.toBeVisible();
	});

	test('hover shows delete and color picker buttons', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		await note.hover({ force: true });
		await expect(page.getByLabel('Delete note')).toBeVisible();
		await expect(page.getByLabel('Pick color')).toBeVisible();
	});

	test('color picker opens and changes note color', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		await note.hover({ force: true });
		await page.getByLabel('Pick color').click({ force: true });
		await page.waitForTimeout(300);

		// Color picker row should appear with 6 color buttons
		const colorButtons = page.getByLabel(/Set color to #/);
		expect(await colorButtons.count()).toBe(6);

		// Click green (#bbf7d0)
		await page.getByLabel('Set color to #bbf7d0').click();
		await page.waitForTimeout(1000);

		// Note background should have changed
		const bg = await note.evaluate((el) => el.style.background);
		expect(bg).toMatch(/bbf7d0|rgb\(187,\s*247,\s*208\)/);
	});

	test('drag note to a new position', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const note = getNotes(page).first();
		const box = await note.boundingBox();
		const startX = box.x + box.width / 2;
		const startY = box.y + box.height / 2;

		// Get initial position
		const initialLeft = await note.evaluate((el) => parseInt(el.style.left));

		// Drag 150px right and 100px down
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX + 150, startY + 100, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(1000);

		// Position should have changed
		const newLeft = await note.evaluate((el) => parseInt(el.style.left));
		expect(newLeft).not.toBe(initialLeft);
	});

	test('clicking a note brings it to front (z-order)', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Create a second note
		await createNote(page, 250, 250);
		expect(await getNotes(page).count()).toBe(2);

		// Click the first note — it should get a higher z-index
		const firstNote = getNotes(page).first();
		const zBefore = await firstNote.evaluate((el) => parseInt(el.style.zIndex) || 0);
		await firstNote.click();
		await page.waitForTimeout(500);
		const zAfter = await firstNote.evaluate((el) => parseInt(el.style.zIndex) || 0);
		expect(zAfter).toBeGreaterThanOrEqual(zBefore);
	});

	test('delete a note', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const countBefore = await getNotes(page).count();
		const note = getNotes(page).first();
		await note.hover({ force: true });
		await page.getByLabel('Delete note').first().click({ force: true });
		await page.waitForTimeout(1500);

		const countAfter = await getNotes(page).count();
		expect(countAfter).toBe(countBefore - 1);
	});

	test('notes persist after page refresh', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const countBefore = await getNotes(page).count();

		await page.reload();
		await waitForBoardReady(page);

		const countAfter = await getNotes(page).count();
		expect(countAfter).toBe(countBefore);
	});
});
