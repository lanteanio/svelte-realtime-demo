import { test, expect } from '@playwright/test';
import { createBoard, waitForBoardReady, waitForWS } from './helpers.js';

test.describe('WebSocket Connection', () => {
	test('WebSocket connects on page load', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;
		expect(ws.url()).toContain('/ws');
	});

	test('WebSocket uses secure wss:// protocol', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;
		expect(ws.url()).toMatch(/^wss:\/\//);
	});

	test('WebSocket exchanges frames after connection', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;

		const sent = ws.waitForEvent('framesent', { timeout: 5000 });
		await sent;

		const received = ws.waitForEvent('framereceived', { timeout: 5000 });
		await received;
	});

	test('connection status shows green wifi icon when connected', async ({ page }) => {
		await page.goto('/');
		await page.waitForTimeout(2000);
		const wifiIcon = page.locator('.text-success').first();
		await expect(wifiIcon).toBeVisible();
	});

	test('global online count appears in navbar', async ({ page }) => {
		await page.goto('/');
		await page.waitForTimeout(2000);
		const onlineText = page.locator('.navbar').getByText(/online/);
		await expect(onlineText).toBeVisible();
		const text = await onlineText.textContent();
		const count = parseInt(text);
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test('WebSocket reconnects after navigation', async ({ page }) => {
		await page.goto('/');
		await page.waitForEvent('websocket', { timeout: 10000 });

		const boardUrl = await createBoard(page, `WS Nav ${Date.now()}`);

		await page.waitForTimeout(1000);
		const wifiIcon = page.locator('.text-success');
		await expect(wifiIcon.first()).toBeVisible({ timeout: 5000 });
	});

	test('only ONE WebSocket connection per session (no leaks)', async ({ page }) => {
		const wsConnections = [];

		page.on('websocket', (ws) => {
			wsConnections.push({ url: ws.url(), openedAt: Date.now(), closed: false });
			ws.on('close', () => {
				const entry = wsConnections.find((c) => c.url === ws.url() && !c.closed);
				if (entry) entry.closed = true;
			});
		});

		// Navigate to home
		await page.goto('/');
		await page.waitForTimeout(2000);
		const afterHome = wsConnections.length;
		console.log(`\n=== WS CONNECTION AUDIT ===`);
		console.log(`After home page load: ${afterHome} connection(s)`);
		expect(afterHome).toBe(1);

		// Navigate to a board
		const boardUrl = await createBoard(page, `WS Audit ${Date.now()}`);
		await waitForBoardReady(page);
		await page.waitForTimeout(2000);
		const afterBoard = wsConnections.filter((c) => !c.closed).length;
		console.log(`After board navigation: ${wsConnections.length} total, ${afterBoard} open`);

		// Should still be just 1 open connection (the original may have been
		// replaced, but we should NOT have multiple open simultaneously)
		expect(afterBoard).toBeLessThanOrEqual(1);

		// Navigate back to home
		await page.goto('/');
		await page.waitForTimeout(2000);
		const afterReturn = wsConnections.filter((c) => !c.closed).length;
		console.log(`After return to home: ${wsConnections.length} total, ${afterReturn} open`);
		expect(afterReturn).toBeLessThanOrEqual(1);

		// Refresh the page
		await page.reload();
		await page.waitForTimeout(2000);
		const afterRefresh = wsConnections.filter((c) => !c.closed).length;
		console.log(`After page refresh: ${wsConnections.length} total, ${afterRefresh} open`);
		expect(afterRefresh).toBeLessThanOrEqual(1);

		console.log(`\nAll WS connections:`);
		wsConnections.forEach((c, i) => {
			console.log(`  ${i + 1}. ${c.closed ? 'CLOSED' : 'OPEN '} - opened at +${c.openedAt - wsConnections[0].openedAt}ms`);
		});
	});

	test('navigating between multiple boards does not leak connections', async ({ page }) => {
		const wsConnections = [];

		page.on('websocket', (ws) => {
			wsConnections.push({ url: ws.url(), closed: false });
			ws.on('close', () => {
				const entry = wsConnections.find((c) => !c.closed);
				if (entry) entry.closed = true;
			});
		});

		await page.goto('/');
		await page.waitForTimeout(1500);

		// Create and visit 3 different boards
		for (let i = 0; i < 3; i++) {
			await page.goto('/');
			await waitForWS(page);
			await page.getByPlaceholder('New board name...').fill(`Leak Test ${i} ${Date.now()}`);
			await page.getByRole('button', { name: 'Create' }).click();
			await page.waitForURL(/\/board\//, { timeout: 15000 });
			await waitForBoardReady(page);
			await page.waitForTimeout(1500);
		}

		const openCount = wsConnections.filter((c) => !c.closed).length;
		console.log(`\nAfter visiting 3 boards: ${wsConnections.length} total WS, ${openCount} still open`);

		// Should not have more than 1 open connection
		expect(openCount).toBeLessThanOrEqual(1);

		// Total connections should be reasonable (1 original + maybe reconnects on nav)
		// but definitely not 3x or more
		console.log(`Total WS connections created: ${wsConnections.length}`);
	});
});
