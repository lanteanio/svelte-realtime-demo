import { test, expect } from '@playwright/test';

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

		await page.getByPlaceholder('New board name...').fill(`Identity Test ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//);

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

		// The .theme-controller is a hidden checkbox inside a label.swap.
		// Use evaluate to toggle it since it may be outside viewport.
		await page.evaluate(() => {
			const checkbox = document.querySelector('.theme-controller');
			checkbox.checked = true;
			checkbox.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await page.waitForTimeout(500);

		const htmlAfter = await page.locator('html').getAttribute('data-theme');
		expect(htmlAfter).toBe('dark');
	});

	test('dark mode changes visual appearance', async ({ page }) => {
		await page.goto('/');

		const bgBefore = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		await page.evaluate(() => {
			const checkbox = document.querySelector('.theme-controller');
			checkbox.checked = true;
			checkbox.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await page.waitForTimeout(500);

		const bgAfter = await page.evaluate(() =>
			getComputedStyle(document.querySelector('.min-h-screen')).backgroundColor
		);

		expect(bgAfter).not.toBe(bgBefore);
	});

	test('unchecking toggle returns to light mode', async ({ page }) => {
		await page.goto('/');

		// Enable dark
		await page.evaluate(() => {
			const cb = document.querySelector('.theme-controller');
			cb.checked = true;
			cb.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await page.waitForTimeout(300);
		expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

		// Disable dark
		await page.evaluate(() => {
			const cb = document.querySelector('.theme-controller');
			cb.checked = false;
			cb.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await page.waitForTimeout(300);
		const theme = await page.locator('html').getAttribute('data-theme');
		expect(theme).not.toBe('dark');
	});
});
