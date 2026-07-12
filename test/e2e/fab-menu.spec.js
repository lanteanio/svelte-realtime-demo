import { test, expect } from '@playwright/test';
import { createBoard, createNote, getNotes, waitForBoardReady } from './helpers.js';

let boardUrl;

test.describe.serial('FAB Menu Actions', () => {
	test('setup: create board with multiple notes', async ({ page }) => {
		boardUrl = await createBoard(page, `FAB Test ${Date.now()}`);
		await waitForBoardReady(page);

		// Create 3 notes at well-separated positions so double-clicks don't
		// accidentally land on an existing note (which would open edit mode instead)
		await createNote(page, 100, 120);
		await createNote(page, 500, 120);
		await createNote(page, 100, 400);

		const count = await getNotes(page).count();
		expect(count).toBe(3);
	});

	test('FAB trigger button is visible', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);
		const fab = page.locator('.fab-trigger');
		await expect(fab).toBeVisible();
	});

	test('focusing FAB reveals action buttons', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);

		await expect(page.locator('.btn-secondary')).toBeVisible(); // Tidy
		await expect(page.locator('.btn-accent')).toBeVisible(); // Rearrange
		await expect(page.locator('.btn-warning')).toBeVisible(); // Shuffle
		await expect(page.locator('.btn-info')).toBeVisible(); // Group by author
	});

	test('tidy notes rearranges z-order', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);

		await page.locator('.btn-secondary').click();
		await page.waitForTimeout(2000);

		expect(await getNotes(page).count()).toBe(3);
	});

	test('rearrange by color moves notes into columns', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);
		await page.locator('.btn-accent').click();
		await page.waitForTimeout(2000);

		const positionsAfter = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const changed = positionsAfter.some(
			(p, i) => p.left !== positionsBefore[i]?.left || p.top !== positionsBefore[i]?.top
		);
		expect(changed).toBe(true);
	});

	test('shuffle scatters notes randomly', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);
		await page.locator('.btn-warning').click();
		await page.waitForTimeout(2000);

		const positionsAfter = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const changed = positionsAfter.some(
			(p, i) => p.left !== positionsBefore[i]?.left || p.top !== positionsBefore[i]?.top
		);
		expect(changed).toBe(true);
	});

	test('group by author rearranges notes', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);
		await page.locator('.btn-info').click();
		await page.waitForTimeout(2000);

		const positionsAfter = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		const changed = positionsAfter.some(
			(p, i) => p.left !== positionsBefore[i]?.left || p.top !== positionsBefore[i]?.top
		);
		expect(changed).toBe(true);
	});

	test('close button dismisses FAB menu', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForBoardReady(page);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);

		await page.locator('.fab-close button').click();
		await page.waitForTimeout(500);

		const closeOpacity = await page.locator('.fab-close button').evaluate(
			(el) => getComputedStyle(el).opacity
		);
		expect(parseFloat(closeOpacity)).toBeLessThan(1);
	});
});
