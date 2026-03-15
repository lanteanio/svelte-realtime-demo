import { test, expect } from '@playwright/test';
import { getCanvas, getNotes, waitForBoardReady, waitForWS } from './helpers.js';

test.describe('Multi-User Realtime Sync', () => {
	let boardUrl;

	test.beforeAll(async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await page.goto('/');
		await waitForWS(page);
		await page.getByPlaceholder('New board name...').fill(`Sync Test ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		boardUrl = new URL(page.url()).pathname;
		await ctx.close();
	});

	test('note created by user A appears for user B', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto(boardUrl);
		await pageB.goto(boardUrl);
		await waitForBoardReady(pageA);
		await waitForBoardReady(pageB);

		// User A creates a note
		const canvas = getCanvas(pageA);
		const box = await canvas.boundingBox();
		await pageA.mouse.dblclick(box.x + 300, box.y + 300);
		await pageA.waitForTimeout(2000);

		// User B should see the note
		await pageB.waitForTimeout(2000);
		expect(await getNotes(pageB).count()).toBeGreaterThanOrEqual(1);

		await ctxA.close();
		await ctxB.close();
	});

	test('note edit by user A is visible to user B', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto(boardUrl);
		await pageB.goto(boardUrl);
		await waitForBoardReady(pageA);
		await waitForBoardReady(pageB);

		// User A edits a note
		const noteA = getNotes(pageA).first();
		await noteA.dblclick();
		const textarea = pageA.locator('textarea');
		await textarea.fill('Synced content!');
		await textarea.blur();
		await pageA.waitForTimeout(2000);

		// User B should see the updated content
		await pageB.waitForTimeout(2000);
		await expect(pageB.getByText('Synced content!')).toBeVisible();

		await ctxA.close();
		await ctxB.close();
	});

	test('note deleted by user A disappears for user B', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto(boardUrl);
		await pageB.goto(boardUrl);
		await waitForBoardReady(pageA);
		await waitForBoardReady(pageB);

		const countBefore = await getNotes(pageB).count();

		// User A deletes a note
		const noteA = getNotes(pageA).first();
		await noteA.hover({ force: true });
		await pageA.getByLabel('Delete note').first().click({ force: true });
		await pageA.waitForTimeout(2000);

		// User B should see one fewer note
		await pageB.waitForTimeout(2000);
		const countAfter = await getNotes(pageB).count();
		expect(countAfter).toBe(countBefore - 1);

		await ctxA.close();
		await ctxB.close();
	});

	test('board settings change syncs across users', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto(boardUrl);
		await pageB.goto(boardUrl);
		await waitForBoardReady(pageA);
		await waitForBoardReady(pageB);

		// User A changes background color
		await pageA.getByLabel('Set background to #ecfdf5').click();
		await pageA.waitForTimeout(2000);

		// User B should see the new background
		await pageB.waitForTimeout(2000);
		const bg = await getCanvas(pageB).evaluate((el) => el.style.background);
		expect(bg).toMatch(/ecfdf5|rgb\(236,\s*253,\s*245\)/);

		await ctxA.close();
		await ctxB.close();
	});

	test('new board created by user A appears in user B board list', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto('/');
		await pageB.goto('/');
		await waitForWS(pageA);
		await waitForWS(pageB);

		const boardName = `LiveSync ${Date.now()}`;
		await pageA.getByPlaceholder('New board name...').fill(boardName);
		await pageA.getByRole('button', { name: 'Create' }).click();
		await pageA.waitForURL(/\/board\//, { timeout: 15000 });

		// User B should see the new board appear
		await pageB.waitForTimeout(3000);
		await expect(pageB.getByText(boardName)).toBeVisible();

		await ctxA.close();
		await ctxB.close();
	});
});
