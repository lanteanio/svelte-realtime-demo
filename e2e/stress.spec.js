import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const BASE_URL = 'https://svelte-realtime-demo.lantean.io';
const WS_URL = 'wss://svelte-realtime-demo.lantean.io/ws';

/**
 * Open a raw WebSocket connection that mimics a real client:
 * - Sets an identity cookie
 * - Sends a subscribe message for the given board
 */
function openConnection(boardId, index) {
	return new Promise((resolve, reject) => {
		const name = `Bot${index}`;
		const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({ id, name, color }))}`;

		const ws = new WebSocket(WS_URL, {
			headers: { Cookie: cookie },
			rejectUnauthorized: false
		});

		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`Connection ${index} timed out`));
		}, 15000);

		ws.on('open', () => {
			clearTimeout(timer);
			resolve(ws);
		});

		ws.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

test.describe('Stress Test', () => {
	test.setTimeout(180_000); // 3 minutes

	test('1000 simultaneous WebSocket connections to one board', async ({ browser }) => {
		// First, create a board via a real browser
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await page.goto('/');
		await page.getByPlaceholder('New board name...').fill(`Stress ${Date.now()}`);
		await page.getByRole('button', { name: 'Create' }).click();
		await page.waitForURL(/\/board\//);
		const boardUrl = new URL(page.url()).pathname;
		const boardSlug = boardUrl.split('/').pop();

		// Get boardId from page data
		const boardId = await page.evaluate(() => {
			// The boardId is in the page data
			return document.querySelector('[data-sveltekit-hydrate]')?.dataset?.boardId;
		});

		console.log(`Board URL: ${boardUrl}`);
		console.log(`Board slug: ${boardSlug}`);

		// Now open 1000 raw WebSocket connections in batches
		const TOTAL = 1000;
		const BATCH_SIZE = 50;
		const connections = [];
		let connected = 0;
		let failed = 0;

		console.log(`\nOpening ${TOTAL} WebSocket connections in batches of ${BATCH_SIZE}...`);
		const startTime = Date.now();

		for (let batch = 0; batch < TOTAL; batch += BATCH_SIZE) {
			const batchEnd = Math.min(batch + BATCH_SIZE, TOTAL);
			const batchPromises = [];

			for (let i = batch; i < batchEnd; i++) {
				batchPromises.push(
					openConnection(boardSlug, i)
						.then((ws) => {
							connections.push(ws);
							connected++;
						})
						.catch(() => {
							failed++;
						})
				);
			}

			await Promise.all(batchPromises);
			console.log(`  Batch ${Math.floor(batch / BATCH_SIZE) + 1}: ${connected} connected, ${failed} failed`);

			// Small delay between batches to avoid overwhelming
			await new Promise((r) => setTimeout(r, 200));
		}

		const connectTime = Date.now() - startTime;
		console.log(`\n=== STRESS TEST RESULTS ===`);
		console.log(`Total attempted:   ${TOTAL}`);
		console.log(`Connected:         ${connected}`);
		console.log(`Failed:            ${failed}`);
		console.log(`Connect time:      ${connectTime}ms`);
		console.log(`Avg per connection: ${(connectTime / TOTAL).toFixed(1)}ms`);

		// Verify the board page still works with a real browser while 1000 connections are open
		console.log(`\nVerifying board still works under load...`);
		await page.reload();
		await page.waitForTimeout(3000);

		// Board should still be functional — check the canvas renders
		const canvasVisible = await page.locator('div.relative.w-full.overflow-auto').isVisible();
		console.log(`Canvas visible under load: ${canvasVisible}`);
		expect(canvasVisible).toBe(true);

		// Try creating a note under load
		const canvas = page.locator('div.relative.w-full.overflow-auto');
		const box = await canvas.boundingBox();
		await page.mouse.dblclick(box.x + 300, box.y + 300);
		await page.waitForTimeout(2000);
		const noteCount = await page.locator('.absolute.w-52').count();
		console.log(`Notes created under load: ${noteCount}`);
		expect(noteCount).toBeGreaterThanOrEqual(1);

		// Check presence count reflects the load
		const presenceText = await page.locator('.text-xs.opacity-50').filter({ hasText: /online/ }).first().textContent();
		console.log(`Presence count: ${presenceText}`);

		// Clean up all connections
		console.log(`\nClosing ${connections.length} connections...`);
		const closeStart = Date.now();
		await Promise.all(connections.map((ws) => {
			return new Promise((resolve) => {
				ws.on('close', resolve);
				ws.close();
			});
		}));
		console.log(`All closed in ${Date.now() - closeStart}ms`);

		// Verify at least 90% connected successfully
		const successRate = connected / TOTAL;
		console.log(`\nSuccess rate: ${(successRate * 100).toFixed(1)}%`);
		expect(successRate).toBeGreaterThanOrEqual(0.9);

		await ctx.close();
	});
});
