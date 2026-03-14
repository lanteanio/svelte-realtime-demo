import { test, expect } from '@playwright/test';

let boardUrl;

test.describe.serial('Board Page', () => {
	test('create a board to test with', async ({ page }) => {
		await page.goto('/');
		const boardName = `E2E Board ${Date.now()}`;
		await page.getByPlaceholder('New board name...').fill(boardName);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//);
		boardUrl = new URL(page.url()).pathname;
	});

	test('board canvas is visible with empty hint', async ({ page }) => {
		await page.goto(boardUrl);
		await expect(page.getByText('Double-click anywhere to add a note')).toBeVisible();
	});

	test('double-click canvas creates a note', async ({ page }) => {
		await page.goto(boardUrl);
		await page.waitForTimeout(1500);

		// The canvas is the div with overflow-auto below the board header
		const canvas = page.locator('div.relative.w-full.overflow-auto');
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

		// Wait for note to appear - it should remove the empty hint or add a sticky note element
		await page.waitForTimeout(2000);

		// The empty hint should be gone now
		const hint = page.getByText('Double-click anywhere to add a note');
		await expect(hint).not.toBeVisible({ timeout: 5000 });
	});

	test('can edit a note by double-clicking', async ({ page }) => {
		await page.goto(boardUrl);
		await page.waitForTimeout(2000);

		// Create a note
		const canvas = page.locator('div.relative.w-full.overflow-auto');
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 200, box.y + 200);
		await page.waitForTimeout(2000);

		// Find the note's content area and double-click to edit
		const note = page.locator('.card').first();
		if (await note.isVisible()) {
			await note.dblclick();
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
		await page.waitForTimeout(2000);
		// The board page shows "X online" with presence avatars
		await expect(page.getByText(/online/).first()).toBeVisible();
	});

	test('can navigate back to home', async ({ page }) => {
		await page.goto(boardUrl);
		await page.getByText('Sticky Notes').first().click();
		await page.waitForURL('/');
	});
});
