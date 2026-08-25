import { test, expect } from '@playwright/test';
import { createNote, getNotes, waitForBoardReady, waitForWS } from './helpers.js';
import { clickFabAction, createFreshBoard, positions } from './board-helpers.js';

// The board offers NO undo, and this spec is what keeps that honest.
//
// The stream's history API restores a LOCAL snapshot only: it issues no call
// and publishes nothing. Wired to Ctrl+Z on a shared board, it showed the
// presser a restored note that stayed deleted for everyone else - a silent,
// confidently wrong answer on the app's headline surface. The wiring is
// removed rather than kept as a local convenience, because a control that
// looks collaborative and is not misleads exactly the visitor who trusts it.
//
// Each test presses the gesture that used to lie and asserts from the state
// the illusion used to repaint: a deleted note must STAY deleted on the
// pressing screen, and a shuffle must STAY shuffled. If anyone rewires the
// history API to these gestures, the repaint returns and these fail on the
// spot - which is the intended tripwire. A real collaborative undo (a
// compensating publish, scoped to your own action, like the kanban delete
// toast) replaces this spec rather than relaxing it.

test.describe('No undo on the shared board', () => {
	test('the header offers no undo controls and Ctrl+Z restores nothing, not even locally', async ({ page }) => {
		await createFreshBoard(page, `No undo ${Date.now()}`);

		// Two notes, not one: the post-reload assertion expects a non-zero
		// count, which a board that never finished loading cannot satisfy.
		await createNote(page, 200, 260);
		await createNote(page, 520, 260);
		await expect(getNotes(page)).toHaveCount(2, { timeout: 15_000 });

		// The controls that carried the illusion are gone.
		await expect(page.getByTestId('board-undo')).toHaveCount(0);
		await expect(page.getByTestId('board-redo')).toHaveCount(0);

		const note = getNotes(page).first();
		await note.hover({ force: true });
		await page.getByLabel('Delete note').first().click({ force: true });
		await expect(getNotes(page)).toHaveCount(1, { timeout: 10_000 });

		// The exact gesture that used to repaint the deleted note. The old
		// wiring restored it locally within a frame, so a bounded settle is
		// enough for the tripwire: if the restore comes back, the count goes
		// to 2 here and this fails.
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(1500);
		await expect(getNotes(page), 'Ctrl+Z must not repaint a deleted note').toHaveCount(1);
		await page.keyboard.press('Control+y');
		await page.keyboard.press('Control+Shift+z');
		await page.waitForTimeout(1500);
		await expect(getNotes(page), 'the redo chords must be equally inert').toHaveCount(1);

		// And the screen was telling the truth: the server agrees.
		await page.reload();
		await waitForWS(page);
		await waitForBoardReady(page);
		await expect(getNotes(page), 'the deletion was real and survives a reload').toHaveCount(1, { timeout: 10_000 });
	});

	test('Ctrl+Z after a FAB shuffle leaves the shuffle in place instead of repainting the old arrangement', async ({ page }) => {
		await createFreshBoard(page, `No FAB undo ${Date.now()}`);
		// Spaced apart: a double-click landing on an existing note opens its
		// editor instead of creating a neighbour.
		for (const [x, y] of [[150, 150], [450, 150], [750, 150]]) await createNote(page, x, y);
		await expect(getNotes(page)).toHaveCount(3, { timeout: 15_000 });
		const before = JSON.stringify(await positions(page));

		await clickFabAction(page, 'Shuffle notes');
		await expect
			.poll(async () => JSON.stringify(await positions(page)), { timeout: 15_000 })
			.not.toBe(before);
		const shuffled = JSON.stringify(await positions(page));

		// The old wiring repainted the pre-shuffle arrangement here - on this
		// screen only - while every other visitor kept the shuffle. Now the
		// pressing screen shows the same truth as everyone else's.
		await page.locator('body').click({ position: { x: 5, y: 5 } });
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(2000);
		expect(
			JSON.stringify(await positions(page)),
			'the shuffle is shared state and stays; no local repaint pretends otherwise'
		).toBe(shuffled);

		await page.reload();
		await waitForWS(page);
		await waitForBoardReady(page);
		expect(
			JSON.stringify(await positions(page)),
			'what the screen showed is what the server holds'
		).toBe(shuffled);
	});
});
