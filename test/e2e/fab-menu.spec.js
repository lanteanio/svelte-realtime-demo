import { test, expect } from '@playwright/test';
import pg from 'pg';
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

// The group arrangements on a board too big for one column per group: 290
// notes of one color by one author cascade past the bottom of the board in a
// single column (y 10155 against the note table's 10000), and 41 single-note
// authors run one column each past its right edge. Seeded straight into the
// harness Postgres, where those bounds are enforced: hundreds of notes through
// the UI would meet the RPC rate limit long before they met the bounds.
test.describe('FAB arrangements on a large board', () => {
	test.skip(process.env.LOCAL_E2E !== '1', 'seeds the harness Postgres, which only the local e2e harness provides');

	const BULK = 290;
	const AUTHORS = 41;

	async function query(text, params) {
		const raw = process.env.DATABASE_URL;
		if (!raw) throw new Error('DATABASE_URL is not set; the local e2e harness provides it');
		if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)) {
			throw new Error(`refusing a non-loopback Postgres: ${new URL(raw).host}`);
		}
		const client = new pg.Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
		await client.connect();
		try {
			return (await client.query(text, params)).rows;
		} finally {
			await client.end();
		}
	}

	/** A new board holding the seeded notes, all at 200,200, open in `page`. */
	async function seededBoard(page) {
		const path = await createBoard(page, `FAB Large ${Date.now()}`);
		const slug = path.split('/').pop();
		await query(`
			INSERT INTO note (board_id, content, x, y, color, creator_name, z_index)
			SELECT b.board_id, '', 200, 200,
			       CASE WHEN g <= $2 THEN '#fef08a' ELSE '#bfdbfe' END,
			       CASE WHEN g <= $2 THEN 'Bulk Author' ELSE 'Author ' || g END,
			       0
			  FROM board AS b, generate_series(1, $2::int + $3::int) AS g
			 WHERE b.slug = $1
		`, [slug, BULK, AUTHORS]);
		await page.goto(path);
		await waitForBoardReady(page);
		await expect(getNotes(page)).toHaveCount(BULK + AUTHORS);
		return slug;
	}

	const storedPositions = async (slug) => new Set((await query(`
		SELECT n.x, n.y FROM note AS n JOIN board AS b ON b.board_id = n.board_id WHERE b.slug = $1
	`, [slug])).map((note) => `${note.x},${note.y}`)).size;

	const shownPositions = (page) => getNotes(page).evaluateAll((notes) =>
		new Set(notes.map((note) => `${note.style.left},${note.style.top}`)).size
	);

	for (const label of ['Re-arrange by color', 'Group by author']) {
		test(`${label} gives every note a place of its own`, async ({ page }) => {
			test.setTimeout(90_000);
			const slug = await seededBoard(page);
			const pageErrors = [];
			page.on('pageerror', (error) => pageErrors.push(error));

			await clickFabAction(page, label);
			// Seeded on one spot, so a distinct position per note is the layout
			// having been written: an arrangement that fails writes nothing.
			await expect.poll(() => storedPositions(slug), { timeout: 15_000, message: 'stored positions' }).toBe(BULK + AUTHORS);
			await expect.poll(() => shownPositions(page), { timeout: 15_000, message: 'positions on the page' }).toBe(BULK + AUTHORS);
			await expect(page.getByTestId('arrange-error')).toHaveCount(0);
			expect(pageErrors).toEqual([]);
		});
	}

	test('a failed arrangement is shown, not left to the console', async ({ page }) => {
		const path = await createBoard(page, `FAB Error ${Date.now()}`);
		// Every frame passes through except the rearrange call, which is answered
		// with a refusal in the shape the server sends one.
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((message) => {
				let request = null;
				try { request = JSON.parse(String(message)); } catch {}
				if (request?.rpc === 'boards/notes/rearrangeNotes') {
					ws.send(JSON.stringify({ topic: '__rpc', event: request.id, data: { id: request.id, ok: false, code: 'INTERNAL_ERROR', error: 'staged failure' } }));
					return;
				}
				server.send(message);
			});
			server.onMessage((message) => ws.send(message));
		});
		await page.goto(path);
		await waitForBoardReady(page);
		const pageErrors = [];
		page.on('pageerror', (error) => pageErrors.push(error));

		await clickFabAction(page, 'Re-arrange by color');
		await expect(page.getByTestId('arrange-error')).toContainText('Could not arrange the board: staged failure');
		expect(pageErrors).toEqual([]);
	});
});
