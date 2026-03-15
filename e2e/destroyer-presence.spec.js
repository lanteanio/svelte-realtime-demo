/**
 * Presence-only destroyer -- find the pure connection ceiling.
 *
 * Same ramp pattern as the cursor destroyer, but users only connect
 * and join board presence. No cursor movement, no continuous messages.
 * This isolates the connection + presence join capacity from the
 * cursor message throughput bottleneck.
 */

import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const WS_URL = 'wss://svelte-realtime-demo.lantean.io/ws';
const BOARD_URL = '/board/stress-me-out';
const LEVELS = [1000, 2000, 3000, 5000, 7000, 10000];

let msgIdCounter = 0;
function nextId() { return 'p' + (msgIdCounter++).toString(36); }

function connectAndJoin(boardId, index) {
	return new Promise((resolve, reject) => {
		const name = `P${index}`;
		const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({ id, name, color }))}`;

		const ws = new WebSocket(WS_URL, {
			headers: { Cookie: cookie },
			rejectUnauthorized: false
		});

		const timer = setTimeout(() => {
			ws.close();
			reject(new Error('timeout'));
		}, 20000);

		ws.on('open', () => {
			clearTimeout(timer);
			// Join board presence immediately
			try {
				ws.send(JSON.stringify({
					rpc: 'boards/cursors/joinBoard',
					id: nextId(),
					args: [boardId]
				}));
			} catch {}
			resolve({ ws, index });
		});

		ws.on('error', () => {
			clearTimeout(timer);
			reject(new Error('error'));
		});
	});
}

test.describe('Presence Destroyer', () => {
	test.setTimeout(1200_000);

	test('ramp to 10K connections -- find presence ceiling', async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();

		await page.goto(BOARD_URL);
		await page.locator('h1').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		await page.waitForTimeout(2000);

		const boardId = await page.evaluate(() => {
			for (const s of document.querySelectorAll('script')) {
				const match = s.textContent?.match(/boardId[:"]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
				if (match) return match[1];
			}
			return null;
		});

		if (!boardId) throw new Error('Could not extract boardId from page');

		console.log(`\n${'='.repeat(60)}`);
		console.log(`  PRESENCE DESTROYER -- finding the connection ceiling`);
		console.log(`  Board: ${BOARD_URL}`);
		console.log(`  UUID:  ${boardId}`);
		console.log(`  No cursor movement -- pure connection + presence joins`);
		console.log(`${'='.repeat(60)}\n`);

		const allUsers = [];
		let lastStableLevel = 0;

		for (const targetCount of LEVELS) {
			const toAdd = targetCount - allUsers.length;
			console.log(`--- Level ${targetCount} (adding ${toAdd}) ---`);

			let connected = 0;
			let failed = 0;
			const connectStart = Date.now();
			const batchSize = 100;

			for (let batch = 0; batch < toAdd; batch += batchSize) {
				const end = Math.min(batch + batchSize, toAdd);
				const promises = [];
				for (let i = batch; i < end; i++) {
					promises.push(
						connectAndJoin(boardId, allUsers.length + i)
							.then((user) => { allUsers.push(user); connected++; })
							.catch(() => { failed++; })
					);
				}
				await Promise.all(promises);
				await new Promise((r) => setTimeout(r, 50));
			}

			const connectTime = Date.now() - connectStart;
			const connectRate = ((connected / (connected + failed)) * 100).toFixed(1);
			console.log(`  Connected: ${connected} new, ${failed} failed (${connectRate}%)`);
			console.log(`  Total active: ${allUsers.length}`);
			console.log(`  Connect time: ${connectTime}ms (${(connectTime / Math.max(toAdd, 1)).toFixed(1)}ms/user)`);

			// Wait for presence to propagate
			await new Promise((r) => setTimeout(r, 3000));

			let serverAlive = true;
			let presenceText = 'N/A';
			let heapMB = 'N/A';

			try {
				await page.reload({ timeout: 15000 });
				await page.waitForTimeout(2000);

				presenceText = await page.locator('.text-xs.opacity-50')
					.filter({ hasText: /online/ }).first()
					.textContent({ timeout: 5000 }).catch(() => 'N/A');

				heapMB = await page.evaluate(() => {
					const m = performance.memory;
					return m ? (m.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A';
				});
			} catch (err) {
				serverAlive = false;
				console.log(`  SERVER UNRESPONSIVE: ${err.message}`);
			}

			console.log(`  Server alive: ${serverAlive}`);
			console.log(`  Presence: ${presenceText}`);
			console.log(`  JS Heap: ${heapMB} MB`);

			const joinRate = connected / Math.max(connected + failed, 1);
			if (!serverAlive) {
				console.log(`\n  STOPPED: server unresponsive at ${targetCount}`);
				break;
			}
			if (joinRate < 0.5) {
				console.log(`\n  STOPPED: join rate below 50% at ${targetCount}`);
				break;
			}

			lastStableLevel = targetCount;
			console.log(`  PASSED\n`);
		}

		// Cleanup
		console.log(`--- Cleanup ---`);
		console.log(`Disconnecting ${allUsers.length} users...`);
		const closeStart = Date.now();
		await Promise.all(allUsers.map((u) =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, 5000);
				u.ws.on('close', () => { clearTimeout(timer); resolve(); });
				u.ws.close();
			})
		));
		console.log(`All disconnected in ${Date.now() - closeStart}ms`);

		let finalAlive = false;
		try {
			await page.goto(BOARD_URL, { timeout: 15000 });
			await page.waitForTimeout(2000);
			finalAlive = await page.locator('.navbar').first().isVisible();
		} catch {}

		console.log(`\n${'='.repeat(60)}`);
		console.log(`  RESULTS`);
		console.log(`  Last stable level: ${lastStableLevel} connections`);
		console.log(`  Server alive after cleanup: ${finalAlive}`);
		console.log(`${'='.repeat(60)}\n`);

		expect(lastStableLevel).toBeGreaterThanOrEqual(1000);
		await ctx.close();
	});
});
