// @ts-check
import { test, expect, devices } from '@playwright/test';

const BASE = 'https://svelte-realtime-demo.lantean.io';

// Use iPhone 13 profile for realistic mobile viewport + touch
const iPhone = devices['iPhone 13'];

test.use({
	...iPhone,
});

test.describe('Mobile Touch', () => {
	test('can create a board and navigate to it', async ({ page }) => {
		await page.goto(BASE);
		await page.getByPlaceholder('New board name...').fill(`Mobile ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).tap();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		expect(page.url()).toContain('/board/');
	});

	test('navbar shows "Demo" on mobile width', async ({ page }) => {
		await page.goto(BASE);
		// On mobile, the short title should be visible
		const shortTitle = page.locator('.sm\\:hidden', { hasText: 'Demo' });
		await expect(shortTitle).toBeVisible();
	});

	test('can create a note with double-tap', async ({ page }) => {
		await page.goto(BASE);
		await page.getByPlaceholder('New board name...').fill(`Touch ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).tap();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		await page.waitForTimeout(1000);

		// Double-tap the canvas to create a note
		const canvas = page.locator('[style*="height: calc"]');
		const box = await canvas.boundingBox();
		if (!box) throw new Error('Canvas not found');

		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.waitForTimeout(1000);

		const notes = page.locator('.absolute.w-52');
		expect(await notes.count()).toBeGreaterThanOrEqual(1);
	});

	test('can drag a note with touch', async ({ page }) => {
		await page.goto(BASE);
		await page.getByPlaceholder('New board name...').fill(`Drag ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).tap();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		await page.waitForTimeout(1000);

		// Create a note first
		const canvas = page.locator('[style*="height: calc"]');
		const box = await canvas.boundingBox();
		if (!box) throw new Error('Canvas not found');

		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.waitForTimeout(1000);

		const note = page.locator('.absolute.w-52').first();
		const noteBefore = await note.boundingBox();
		if (!noteBefore) throw new Error('Note not found');

		// Drag the note 100px to the right using touch
		const startX = noteBefore.x + noteBefore.width / 2;
		const startY = noteBefore.y + noteBefore.height / 2;

		await page.touchscreen.tap(startX, startY);
		await page.waitForTimeout(200);

		// Simulate a touch drag
		await page.evaluate(async ({ sx, sy, ex, ey }) => {
			const el = document.elementFromPoint(sx, sy);
			if (!el) return;

			el.dispatchEvent(new PointerEvent('pointerdown', {
				clientX: sx, clientY: sy, pointerId: 1, pointerType: 'touch',
				bubbles: true, cancelable: true
			}));

			// Move in steps for smooth dragging
			const steps = 10;
			for (let i = 1; i <= steps; i++) {
				const x = sx + (ex - sx) * (i / steps);
				const y = sy + (ey - sy) * (i / steps);
				el.dispatchEvent(new PointerEvent('pointermove', {
					clientX: x, clientY: y, pointerId: 1, pointerType: 'touch',
					bubbles: true, cancelable: true
				}));
				await new Promise(r => setTimeout(r, 16));
			}

			el.dispatchEvent(new PointerEvent('pointerup', {
				clientX: ex, clientY: ey, pointerId: 1, pointerType: 'touch',
				bubbles: true, cancelable: true
			}));
		}, { sx: startX, sy: startY, ex: startX + 100, ey: startY });

		await page.waitForTimeout(500);

		const noteAfter = await note.boundingBox();
		if (!noteAfter) throw new Error('Note disappeared after drag');

		// The note should have moved at least 50px to the right
		expect(noteAfter.x).toBeGreaterThan(noteBefore.x + 50);
	});

	test('note controls are visible on mobile without hover', async ({ page }) => {
		await page.goto(BASE);
		await page.getByPlaceholder('New board name...').fill(`Controls ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).tap();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		await page.waitForTimeout(1000);

		// Create a note
		const canvas = page.locator('[style*="height: calc"]');
		const box = await canvas.boundingBox();
		if (!box) throw new Error('Canvas not found');

		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.waitForTimeout(1000);

		// On mobile, the delete button should be visible without hover
		const deleteBtn = page.locator('[aria-label="Delete note"]').first();
		await expect(deleteBtn).toBeVisible();
	});

	test('can delete a note on mobile', async ({ page }) => {
		await page.goto(BASE);
		await page.getByPlaceholder('New board name...').fill(`Delete ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).tap();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		await page.waitForTimeout(1000);

		// Create a note
		const canvas = page.locator('[style*="height: calc"]');
		const box = await canvas.boundingBox();
		if (!box) throw new Error('Canvas not found');

		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.touchscreen.tap(box.x + 150, box.y + 150);
		await page.waitForTimeout(1000);

		const notes = page.locator('.absolute.w-52');
		expect(await notes.count()).toBe(1);

		// Tap the delete button (visible on mobile)
		await page.locator('[aria-label="Delete note"]').first().tap();
		await page.waitForTimeout(500);

		expect(await notes.count()).toBe(0);
	});
});
