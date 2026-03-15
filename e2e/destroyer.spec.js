/**
 * Destroyer test -- find the absolute ceiling of what the server can handle.
 *
 * Ramps up connections in waves: 1K, 2K, 3K, 5K, 7K, 10K.
 * At each plateau, all users move cursors for 10 seconds while we measure:
 * - FPS (frame timing from a real browser on the board)
 * - Presence count (how many actually joined the board)
 * - Server responsiveness (can we still load a page?)
 * - Memory usage (client-side JS heap)
 *
 * When something breaks (server unresponsive, <50% join rate, or FPS
 * drops below 5), we stop and report the last stable level.
 */

import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const WS_URL = 'wss://svelte-realtime-demo.lantean.io/ws';
const BOARD_URL = '/board/plucky-noodle-184';
const LEVELS = [1000, 2000, 3000, 5000, 7000, 10000];

let msgIdCounter = 0;
function nextId() { return 'd' + (msgIdCounter++).toString(36); }

function connectUser(index) {
	return new Promise((resolve, reject) => {
		const name = `D${index}`;
		const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({ id, name, color }))}`;

		const ws = new WebSocket(WS_URL, {
			headers: { Cookie: cookie },
			rejectUnauthorized: false
		});

		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`timeout`));
		}, 20000);

		ws.on('open', () => {
			clearTimeout(timer);
			resolve({ ws, id, name, index });
		});

		ws.on('error', () => {
			clearTimeout(timer);
			reject(new Error(`error`));
		});
	});
}

function startCursorMovement(user, boardId) {
	const { ws } = user;

	// Join board presence
	try {
		ws.send(JSON.stringify({ rpc: 'boards/cursors/joinBoard', id: nextId(), args: [boardId] }));
	} catch {}

	let x = 50 + Math.random() * 1100;
	let y = 50 + Math.random() * 550;
	let vx = (Math.random() - 0.5) * 8;
	let vy = (Math.random() - 0.5) * 8;

	return setInterval(() => {
		x += vx; y += vy;
		if (x < 10 || x > 1200) { vx = -vx; x = Math.max(10, Math.min(1200, x)); }
		if (y < 10 || y > 650) { vy = -vy; y = Math.max(10, Math.min(650, y)); }
		vx += (Math.random() - 0.5) * 1.5;
		vy += (Math.random() - 0.5) * 1.5;
		vx = Math.max(-12, Math.min(12, vx));
		vy = Math.max(-12, Math.min(12, vy));

		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({
					rpc: 'boards/cursors/moveCursor',
					id: nextId(),
					args: [boardId, { x: Math.round(x), y: Math.round(y) }]
				}));
			}
		} catch {}
	}, 50);
}

async function measureFrames(page) {
	return page.evaluate(() => {
		return new Promise((resolve) => {
			const frames = [];
			let lastTime = performance.now();
			function measure() {
				const now = performance.now();
				frames.push(now - lastTime);
				lastTime = now;
				if (frames.length < 60) {
					requestAnimationFrame(measure);
				} else {
					const sorted = frames.sort((a, b) => a - b);
					resolve({
						fps: Math.round(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)),
						p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
						p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
						max: +sorted[sorted.length - 1].toFixed(1)
					});
				}
			}
			requestAnimationFrame(measure);
		});
	});
}

test.describe('Destroyer Test', () => {
	test.setTimeout(1200_000); // 20 minutes

	test('ramp to 10K users -- find the ceiling', async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();

		// Navigate to the board and extract the UUID
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
		console.log(`  DESTROYER TEST -- finding the ceiling`);
		console.log(`  Board: ${BOARD_URL}`);
		console.log(`  UUID:  ${boardId}`);
		console.log(`  Levels: ${LEVELS.join(', ')}`);
		console.log(`${'='.repeat(60)}\n`);

		const allUsers = [];
		const allIntervals = [];
		let lastStableLevel = 0;

		for (const targetCount of LEVELS) {
			const toAdd = targetCount - allUsers.length;
			console.log(`--- Level ${targetCount} (adding ${toAdd} users) ---`);

			// Connect new users in batches
			const batchSize = 100;
			let connected = 0;
			let failed = 0;
			const connectStart = Date.now();

			for (let batch = 0; batch < toAdd; batch += batchSize) {
				const end = Math.min(batch + batchSize, toAdd);
				const promises = [];
				for (let i = batch; i < end; i++) {
					promises.push(
						connectUser(allUsers.length + i)
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

			// Start cursor movement for new users only
			const newUsers = allUsers.slice(allUsers.length - connected);
			for (const user of newUsers) {
				allIntervals.push(startCursorMovement(user, boardId));
			}

			// Let cursors settle
			await new Promise((r) => setTimeout(r, 3000));

			// Measure from the real browser
			let serverAlive = true;
			let frames = null;
			let presenceText = 'N/A';
			let heapMB = 'N/A';

			try {
				await page.reload({ timeout: 15000 });
				await page.waitForTimeout(3000);

				frames = await measureFrames(page);

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
			if (frames) {
				console.log(`  FPS: ${frames.fps}  |  p50: ${frames.p50}ms  |  p95: ${frames.p95}ms  |  max: ${frames.max}ms`);
			}
			console.log(`  Presence: ${presenceText}`);
			console.log(`  JS Heap: ${heapMB} MB`);

			// Check if we should stop
			const joinRate = connected / Math.max(connected + failed, 1);
			if (!serverAlive) {
				console.log(`\n  STOPPED: server became unresponsive at ${targetCount} users`);
				break;
			}
			if (joinRate < 0.5) {
				console.log(`\n  STOPPED: join rate dropped below 50% (${connectRate}%) at ${targetCount} users`);
				break;
			}
			if (frames && frames.fps < 5) {
				console.log(`\n  STOPPED: FPS dropped below 5 (${frames.fps}) at ${targetCount} users`);
				break;
			}

			lastStableLevel = targetCount;
			console.log(`  PASSED\n`);
		}

		// Cleanup
		console.log(`--- Cleanup ---`);
		console.log(`Stopping ${allIntervals.length} cursor intervals...`);
		allIntervals.forEach((id) => clearInterval(id));

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

		// Final health check
		let finalAlive = false;
		try {
			await page.goto(BOARD_URL, { timeout: 15000 });
			await page.waitForTimeout(2000);
			finalAlive = await page.locator('.navbar').first().isVisible();
		} catch {}

		console.log(`\n${'='.repeat(60)}`);
		console.log(`  RESULTS`);
		console.log(`  Last stable level: ${lastStableLevel} users`);
		console.log(`  Server alive after cleanup: ${finalAlive}`);
		console.log(`${'='.repeat(60)}\n`);

		expect(lastStableLevel).toBeGreaterThanOrEqual(1000);
		await ctx.close();
	});
});
