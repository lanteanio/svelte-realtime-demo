import { test, expect } from '@playwright/test';
import { waitForWS } from './helpers.js';

test.describe('Identity System', () => {
	test('user gets a random name on first visit', async ({ page }) => {
		await page.goto('/');
		const nameEl = page.locator('.navbar .font-medium');
		await expect(nameEl).toBeVisible();
		const name = await nameEl.textContent();
		expect(name.trim().split(' ')).toHaveLength(2);
	});

	test('identity persists across page navigations', async ({ page }) => {
		await page.goto('/');
		const name1 = await page.locator('.navbar .font-medium').textContent();

		await waitForWS(page);
		await page.getByPlaceholder('New board name...').fill(`Identity Test ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//, { timeout: 15000 });

		const name2 = await page.locator('.navbar .font-medium').textContent();
		expect(name2).toBe(name1);
	});

	test('identity persists after page refresh (cookie)', async ({ page }) => {
		await page.goto('/');
		const name1 = await page.locator('.navbar .font-medium').textContent();

		await page.reload();
		await page.waitForTimeout(1000);

		const name2 = await page.locator('.navbar .font-medium').textContent();
		expect(name2).toBe(name1);
	});

	test('identity cookie is set', async ({ page }) => {
		await page.goto('/');
		const cookies = await page.context().cookies();
		const identityCookie = cookies.find((c) => c.name === 'identity');
		expect(identityCookie).toBeTruthy();
	});

	test('user color icon is displayed', async ({ page }) => {
		await page.goto('/');
		const userIcon = page.locator('.navbar .font-medium').locator('..');
		await expect(userIcon).toBeVisible();
	});

	test('different browser contexts get different identities', async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const pageA = await ctxA.newPage();
		const pageB = await ctxB.newPage();

		await pageA.goto('/');
		await pageB.goto('/');

		const nameA = await pageA.locator('.navbar .font-medium').textContent();
		const nameB = await pageB.locator('.navbar .font-medium').textContent();

		expect(nameA.trim().split(' ')).toHaveLength(2);
		expect(nameB.trim().split(' ')).toHaveLength(2);

		await ctxA.close();
		await ctxB.close();
	});
});

test.describe('Theme Toggle', () => {
	test('theme toggle button exists in navbar', async ({ page }) => {
		await page.goto('/');
		const toggle = page.locator('.theme-controller');
		await expect(toggle).toBeAttached();
	});

	test('clicking theme toggle switches to dark mode', async ({ page }) => {
		await page.goto('/');

		const bgBefore = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		// Click the label (swap) that wraps the hidden checkbox
		await page.locator('label.swap').click();
		await page.waitForTimeout(500);

		const bgAfter = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		// Background should have changed (dark theme has different bg)
		expect(bgAfter).not.toBe(bgBefore);
	});

	test('dark mode changes visual appearance', async ({ page }) => {
		await page.goto('/');

		const bgBefore = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		await page.locator('label.swap').click();
		await page.waitForTimeout(500);

		const bgAfter = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		expect(bgAfter).not.toBe(bgBefore);
	});

	test('toggling back restores light mode', async ({ page }) => {
		await page.goto('/');

		const bgOriginal = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		// Toggle dark
		await page.locator('label.swap').click();
		await page.waitForTimeout(300);
		const bgDark = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);
		expect(bgDark).not.toBe(bgOriginal);

		// Toggle light
		await page.locator('label.swap').click();
		await page.waitForTimeout(300);
		const bgLight = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);
		expect(bgLight).toBe(bgOriginal);
	});
});
