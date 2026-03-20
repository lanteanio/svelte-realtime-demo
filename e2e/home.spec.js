import { test, expect } from '@playwright/test';
import { waitForWS } from './helpers.js';

test.describe('Home Page', () => {
	test('loads and displays board list', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('.navbar')).toBeVisible();
		await expect(page.getByText('Svelte Realtime Demo')).toBeVisible();
		await expect(page.getByText('Boards')).toBeVisible();
	});

	test('shows create board form', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByPlaceholder('New board name...')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create' })).toBeVisible();
	});

	test('creates a new board and navigates to it', async ({ page }) => {
		await page.goto('/');
		await waitForWS(page);
		const boardName = `Test Board ${Date.now()}`;
		await page.getByPlaceholder('New board name...').fill(boardName);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//, { timeout: 15000 });
		expect(page.url()).toContain('/board/');
	});

	test('shows navbar with identity and connection status', async ({ page }) => {
		await page.goto('/');
		const navbar = page.locator('.navbar');
		await expect(navbar).toBeVisible();
		await expect(navbar.getByText(/online/)).toBeVisible();
	});

	test('board cards link to board pages', async ({ page }) => {
		await page.goto('/');
		await page.waitForTimeout(2000);
		const boardLink = page.locator('a[href*="/board/"]').first();
		if (await boardLink.isVisible()) {
			await boardLink.click();
			await page.waitForURL(/\/board\//);
			expect(page.url()).toContain('/board/');
		}
	});
});
