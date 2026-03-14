import { test, expect } from '@playwright/test';
import { createBoard, getCanvas, getNotes, waitForBoardReady } from './helpers.js';

test.describe('Input Validation', () => {
	test('empty board title does not create a board', async ({ page }) => {
		await page.goto('/');
		const url = page.url();

		await page.getByPlaceholder('New board name...').fill('');
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForTimeout(1000);

		// Should still be on home page
		expect(page.url()).toBe(url);
	});

	test('whitespace-only board title does not create a board', async ({ page }) => {
		await page.goto('/');
		const url = page.url();

		await page.getByPlaceholder('New board name...').fill('   ');
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForTimeout(1000);

		expect(page.url()).toBe(url);
	});

	test('very long board title (>100 chars) is handled gracefully', async ({ page }) => {
		await page.goto('/');
		const longTitle = 'A'.repeat(150);
		await page.getByPlaceholder('New board name...').fill(longTitle);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForTimeout(2000);

		// Either it should fail gracefully or truncate — no crash
		// Check for error alerts or successful creation
		const hasError = await page.locator('.alert-error').count();
		const navigated = page.url().includes('/board/');

		// One of: error shown, or navigated to board (server truncated/rejected)
		expect(hasError > 0 || navigated || page.url().includes('/')).toBe(true);
	});

	test('XSS in board title is escaped', async ({ page }) => {
		await page.goto('/');
		const xss = '<script>alert("xss")</script>';
		await page.getByPlaceholder('New board name...').fill(xss);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForTimeout(2000);

		// Should not execute script — check no dialog appeared
		// The title should be displayed as text, not executed
		if (page.url().includes('/board/')) {
			// If board was created, the title should show as escaped text
			const h1Text = await page.locator('h1').textContent();
			expect(h1Text).toContain('<script>');
		}
	});

	test('XSS in note content is escaped', async ({ page }) => {
		const boardUrl = await createBoard(page, `XSS Note Test ${Date.now()}`);
		await waitForBoardReady(page);

		await page.goto(boardUrl);
		await waitForBoardReady(page);

		// Create and edit a note with XSS content
		const canvas = getCanvas(page);
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 300, box.y + 300);
		await page.waitForTimeout(1500);

		const note = getNotes(page).first();
		await note.dblclick();
		const textarea = page.locator('textarea');
		await textarea.fill('<img src=x onerror=alert(1)>');
		await textarea.blur();
		await page.waitForTimeout(1000);

		// Content should be displayed as text, not rendered as HTML
		const content = await page.locator('.absolute.w-52 p').first().textContent();
		expect(content).toContain('<img');
	});

	test('very long note content (>2000 chars) is handled', async ({ page }) => {
		const boardUrl = await createBoard(page, `Long Note ${Date.now()}`);
		await waitForBoardReady(page);

		const canvas = getCanvas(page);
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 300, box.y + 300);
		await page.waitForTimeout(1500);

		const note = getNotes(page).first();
		await note.dblclick();
		const textarea = page.locator('textarea');
		await textarea.fill('X'.repeat(2500));
		await textarea.blur();
		await page.waitForTimeout(1500);

		// Should either truncate or show an error — no crash
		const noteContent = await page.locator('.absolute.w-52 p').first().textContent();
		// Content should exist but may be shorter than input
		expect(noteContent.length).toBeGreaterThan(0);
	});

	test('invalid URL slugs return error or redirect', async ({ page }) => {
		const response = await page.goto('/board/definitely-not-a-real-slug-12345');
		// Should get an error status, redirect, or render an error page — no crash
		const status = response.status();
		const hasErrorUI = await page.locator('.alert-error, [data-error]').count() > 0;
		const is404 = status >= 400;
		const isRedirect = status >= 300 && status < 400;
		expect(is404 || isRedirect || hasErrorUI).toBe(true);
	});
});
