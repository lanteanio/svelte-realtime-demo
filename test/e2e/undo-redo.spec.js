import { test, expect } from '@playwright/test';
import { createBoard, createNote, getNotes, waitForBoardReady, waitForWS } from './helpers.js';

let boardUrl;

test.describe.serial('Undo / Redo', () => {
	test('setup: create a board', async ({ page }) => {
		boardUrl = await createBoard(page, `Undo Test ${Date.now()}`);
	});

	test('Ctrl+Z undoes note creation', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
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
		await waitForWS(page);
		await waitForBoardReady(page);

		const before = await getNotes(page).count();

		// Create a note
		await createNote(page, 300, 300);
		expect(await getNotes(page).count()).toBe(before + 1);

		// Undo
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(before);

		// Redo
		await page.keyboard.press('Control+Shift+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(before + 1);
	});

	test('Ctrl+Y also redoes', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
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
		await waitForWS(page);
		await waitForBoardReady(page);

		// Make sure we have a note
		if (await getNotes(page).count() === 0) {
			await createNote(page, 300, 300);
		}
		const countBefore = await getNotes(page).count();

		// Double-click the note content area to edit
		const noteContent = getNotes(page).first().locator('p');
		await noteContent.dblclick({ force: true });
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
		await waitForWS(page);
		await waitForBoardReady(page);

		if (await getNotes(page).count() === 0) {
			await createNote(page, 300, 300);
		}
		const countBefore = await getNotes(page).count();

		// Delete a note (force needed - canvas overlay has high z-index)
		const note = getNotes(page).first();
		await note.hover({ force: true });
		await page.getByLabel('Delete note').first().click({ force: true });
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore - 1);

		// Undo the deletion
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		expect(await getNotes(page).count()).toBe(countBefore);
	});

	// What every assertion above actually measures, stated so the suite stops
	// implying more than it checks.
	//
	// Undo here restores the LOCAL snapshot of the stream and nothing else: it
	// issues no call, publishes nothing, and never reaches the server. Each test
	// above reads the count in the same tab that pressed the key, which is the
	// one place the restore is visible - so they would all pass exactly as they
	// do now if the note stayed deleted everywhere else, which is what happens.
	//
	// This pins the behaviour that IS true rather than the one a visitor
	// reasonably expects from a shared board, because an assertion that undo
	// persists would fail today. Whether to make undo real or to stop offering a
	// collaborative one is an open product decision; when it is taken, this test
	// fails and has to be rewritten, which is the point of pinning it.
	test('undo restores the local view only, and the deletion survives a reload', async ({ page }) => {
		await page.goto(boardUrl);
		await waitForWS(page);
		await waitForBoardReady(page);

		// Two notes, not one, and this is load-bearing. With a single note the
		// post-reload assertion would expect ZERO, which a page that has not
		// finished loading its notes satisfies just as well as a genuinely
		// deleted note - the assertion would pass without the server ever being
		// consulted. Expecting a non-zero count means the board must actually
		// have loaded for the assertion to hold at all.
		while (await getNotes(page).count() < 2) {
			await createNote(page, 200 + (await getNotes(page).count()) * 320, 260);
			await page.waitForTimeout(800);
		}
		const countBefore = await getNotes(page).count();
		expect(countBefore, 'the reload assertion is vacuous below two notes').toBeGreaterThanOrEqual(2);

		const note = getNotes(page).first();
		await note.hover({ force: true });
		await page.getByLabel('Delete note').first().click({ force: true });
		await expect(getNotes(page)).toHaveCount(countBefore - 1, { timeout: 10_000 });

		await page.keyboard.press('Control+z');
		await expect(getNotes(page), 'the local view restores the note').toHaveCount(countBefore, { timeout: 10_000 });

		// The reload is the whole test: it can only show what the server holds,
		// so it separates a restored note from a repainted one.
		await page.reload();
		await waitForWS(page);
		await waitForBoardReady(page);
		await expect(
			getNotes(page),
			'undo does not reach the server, so the note is still deleted after a reload'
		).toHaveCount(countBefore - 1, { timeout: 10_000 });
	});
});
