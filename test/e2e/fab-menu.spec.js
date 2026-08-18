import { test, expect } from '@playwright/test';
import { createBoard, createNote, getNotes, waitForBoardReady, waitForWS } from './helpers.js';
import { clickFabAction } from './board-helpers.js';

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
		await waitForWS(page);
		await waitForBoardReady(page);
		const fab = page.locator('.fab-trigger');
		await expect(fab).toBeVisible();
	});

	test('focusing FAB reveals action buttons', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
		await waitForBoardReady(page);

		const fab = page.locator('.fab-trigger');
		await fab.focus();
		await page.waitForTimeout(500);

		// Located by the label each action carries, not by the colour it wears.
		// The colours here are differentiation between four sibling buttons, so
		// asserting them pinned a design choice rather than the menu's contents:
		// a renamed or removed action passes as long as some element keeps the
		// class, and re-dressing a button fails a test that has nothing to do
		// with dress. The tooltip is what a visitor reads to tell them apart.
		for (const label of ['Tidy z-order', 'Re-arrange by color', 'Shuffle notes', 'Group by author']) {
			await expect(page.locator(`[data-tip="${label}"] button`)).toBeVisible();
		}

		// Shuffle must not wear the warning dress. In this app that yellow means
		// one thing - a control that induces chaos or failure on purpose - and
		// Shuffle rearranges a layout rather than breaking anything, so wearing
		// it made the colour stop predicting behaviour everywhere else. Asserted
		// as absence of that specific class rather than presence of the current
		// one, because the vocabulary rule is what must hold; which neutral hue
		// it wears instead is a design choice that may change.
		await expect(
			page.locator('[data-tip="Shuffle notes"] button'),
			'warning is reserved for controls that deliberately break something'
		).not.toHaveClass(/btn-warning/);
	});

	test('tidy notes rearranges z-order', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
		await waitForBoardReady(page);

		await clickFabAction(page, 'Tidy z-order');
		await page.waitForTimeout(2000);

		expect(await getNotes(page).count()).toBe(3);
	});

	test('rearrange by color moves notes into columns', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		await clickFabAction(page, 'Re-arrange by color');
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
		await waitForWS(page);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		await clickFabAction(page, 'Shuffle notes');
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
		await waitForWS(page);
		await waitForBoardReady(page);

		const positionsBefore = await getNotes(page).evaluateAll((notes) =>
			notes.map((n) => ({ left: n.style.left, top: n.style.top }))
		);

		await clickFabAction(page, 'Group by author');
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
		await waitForWS(page);
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
