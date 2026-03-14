import { test, expect } from '@playwright/test';
import { createBoard, createNote, getNotes, waitForBoardReady } from './helpers.js';

let boardUrl;

test.describe.serial('Undo / Redo', () => {
	test('setup: create a board', async ({ page }) => {
		boardUrl = await createBoard(page, `Undo Test ${Date.now()}`);
	});

	test('Ctrl+Z undoes note creation', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Create a note
		await createNote(page, 300, 300);
		expect(await getNotes(page).count()).toBe(1);

		// Undo
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(0);
	});

	test('Ctrl+Shift+Z redoes undone action', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Create a note
		await createNote(page, 300, 300);
		expect(await getNotes(page).count()).toBe(1);

		// Undo
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(0);

		// Redo
		await page.keyboard.press('Control+Shift+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(1);
	});

	test('Ctrl+Y also redoes', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		await createNote(page, 300, 300);
		const countBefore = await getNotes(page).count();

		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore - 1);

		await page.keyboard.press('Control+y');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore);
	});

	test('undo does nothing when editing a textarea', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Make sure we have a note
		if (await getNotes(page).count() === 0) {
			await createNote(page, 300, 300);
		}
		const countBefore = await getNotes(page).count();

		// Double-click to edit
		const note = getNotes(page).first();
		await note.dblclick();
		const textarea = page.locator('textarea');
		await expect(textarea).toBeVisible();

		// Ctrl+Z while in textarea should NOT undo note creation
		await textarea.press('Control+z');
		await page.waitForTimeout(500);

		await textarea.press('Escape');
		await page.waitForTimeout(500);

		expect(await getNotes(page).count()).toBe(countBefore);
	});

	test('undo note deletion restores the note', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		if (await getNotes(page).count() === 0) {
			await createNote(page, 300, 300);
		}
		const countBefore = await getNotes(page).count();

		// Delete a note
		const note = getNotes(page).first();
		await note.hover();
		await page.getByLabel('Delete note').first().click();
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore - 1);

		// Undo the deletion
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore);
	});
});
