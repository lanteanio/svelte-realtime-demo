import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';

const WS_URL = 'wss://svelte-realtime-demo.lantean.io/ws';
const BOARD_URL = '/board/bouncy-llama-854';
const BOARD_SLUG = 'plucky-jellyfish-209';

let msgIdCounter = 0;
function nextId() { return 's' + (msgIdCounter++).toString(36); }

/**
 * Connect a fake user via WebSocket.
 */
function connectUser(index) {
	return new Promise((resolve, reject) => {
		const name = `Bot ${index}`;
		const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({ id, name, color }))}`;

		const ws = new WebSocket(WS_URL, {
			headers: { Cookie: cookie },
			rejectUnauthorized: false
		});

		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(`User ${index} timed out`));
		}, 15000);

		ws.on('open', () => {
			clearTimeout(timer);
			resolve({ ws, id, name, color, index });
		});

		ws.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Join board presence and start moving cursor.
 * Uses the actual svelte-realtime RPC wire format:
 *   { rpc: "path", id: "uniqueId", args: [...] }
 */
function startCursorMovement(user, boardSlug) {
	const { ws } = user;

	// Join board presence via RPC
	try {
		ws.send(JSON.stringify({
			rpc: 'boards/cursors/joinBoard',
			id: nextId(),
			args: [boardSlug]
		}));
	} catch {}

	// Random starting position and velocity
	let x = 50 + Math.random() * 1100;
	let y = 50 + Math.random() * 550;
	let vx = (Math.random() - 0.5) * 8;
	let vy = (Math.random() - 0.5) * 8;

	return setInterval(() => {
		// Bounce off walls
		x += vx; y += vy;
		if (x < 10 || x > 1200) { vx = -vx; x = Math.max(10, Math.min(1200, x)); }
		if (y < 10 || y > 650) { vy = -vy; y = Math.max(10, Math.min(650, y)); }
		// Slight randomness
		vx += (Math.random() - 0.5) * 1.5;
		vy += (Math.random() - 0.5) * 1.5;
		vx = Math.max(-12, Math.min(12, vx));
		vy = Math.max(-12, Math.min(12, vy));

		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({
					rpc: 'boards/cursors/moveCursor',
					id: nextId(),
					args: [boardSlug, { x: Math.round(x), y: Math.round(y) }]
				}));
			}
		} catch {}
	}, 50); // 20 updates/sec per user
}

test.describe('Stress Test', () => {
	test.setTimeout(600_000);

	test('1000 users with live cursors on one board', async ({ browser }) => {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();

		// Navigate to the stress board and extract the real board UUID
		await page.goto(BOARD_URL);
		await page.locator('h1').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
		await page.waitForTimeout(2000);

		// Extract boardId (UUID) from the page — RPCs need the UUID, not the slug
		const boardId = await page.evaluate(() => {
			for (const s of document.querySelectorAll('script')) {
				const match = s.textContent?.match(/boardId[:"]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
				if (match) return match[1];
			}
			return null;
		});

		if (!boardId) {
			throw new Error('Could not extract boardId UUID from page. The bots need the UUID, not the slug.');
		}

		console.log(`\n=== STRESS TEST: 1000 CURSORS ON ${BOARD_URL} ===`);
		console.log(`Board UUID: ${boardId}\n`);

		// Connect 1000 users in batches
		const TOTAL = 1000;
		const BATCH = 50;
		const users = [];
		let connected = 0;
		let failed = 0;

		console.log(`Connecting ${TOTAL} users...`);
		const connectStart = Date.now();

		for (let batch = 0; batch < TOTAL; batch += BATCH) {
			const promises = [];
			for (let i = batch; i < Math.min(batch + BATCH, TOTAL); i++) {
				promises.push(
					connectUser(i)
						.then((user) => { users.push(user); connected++; })
						.catch(() => { failed++; })
				);
			}
			await Promise.all(promises);
			if ((batch + BATCH) % 200 === 0 || batch + BATCH >= TOTAL) {
				console.log(`  ${connected} connected, ${failed} failed`);
			}
			await new Promise((r) => setTimeout(r, 100));
		}

		const connectTime = Date.now() - connectStart;
		console.log(`\nAll connected in ${connectTime}ms (${(connectTime / TOTAL).toFixed(1)}ms/user)\n`);

		// All users join board and start moving cursors
		console.log(`Starting cursor movement for ${users.length} users...`);
		const intervals = users.map((user) => startCursorMovement(user, boardId));

		// Wait a moment for joins to propagate, then reload to see cursors
		await page.waitForTimeout(2000);
		await page.reload();
		await page.waitForTimeout(3000);

		// Measure frame performance during cursor storm
		const metrics = await page.evaluate(() => {
			return new Promise((resolve) => {
				const frames = [];
				let lastTime = performance.now();

				function measure() {
					const now = performance.now();
					frames.push(now - lastTime);
					lastTime = now;
					if (frames.length < 120) {
						requestAnimationFrame(measure);
					} else {
						const sorted = frames.sort((a, b) => a - b);
						resolve({
							frameCount: frames.length,
							avgFrameTime: (frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(1),
							p50: sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
							p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
							p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(1),
							maxFrameTime: sorted[sorted.length - 1].toFixed(1),
							estimatedFPS: (1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)).toFixed(0)
						});
					}
				}
				requestAnimationFrame(measure);
			});
		});

		console.log(`=== FRAME METRICS (1000 cursors active) ===`);
		console.log(`Frames sampled:    ${metrics.frameCount}`);
		console.log(`Avg frame time:    ${metrics.avgFrameTime}ms`);
		console.log(`Estimated FPS:     ${metrics.estimatedFPS}`);
		console.log(`p50 frame time:    ${metrics.p50}ms`);
		console.log(`p95 frame time:    ${metrics.p95}ms`);
		console.log(`p99 frame time:    ${metrics.p99}ms`);
		console.log(`Max frame time:    ${metrics.maxFrameTime}ms`);

		const canvasVisible = await page.locator('div.relative.w-full.overflow-auto').isVisible();
		console.log(`\nCanvas responsive:  ${canvasVisible}`);

		const cursorCount = await page.locator('svg.absolute.pointer-events-none g').count();
		console.log(`Visible cursors:   ${cursorCount}`);

		const presenceText = await page.locator('.text-xs.opacity-50').filter({ hasText: /online/ }).first().textContent().catch(() => 'N/A');
		console.log(`Presence display:  ${presenceText}`);

		// Let cursors fly for 10 seconds total
		const elapsed = 5000; // ~5s already spent
		if (elapsed < 10000) {
			console.log(`\nCursors flying for ${((10000 - elapsed) / 1000).toFixed(0)}s more...`);
			await new Promise((r) => setTimeout(r, 10000 - elapsed));
		}

		// Memory snapshot
		const mem = await page.evaluate(() => {
			const m = performance.memory;
			return m ? {
				jsHeapMB: (m.usedJSHeapSize / 1024 / 1024).toFixed(1),
				totalHeapMB: (m.totalJSHeapSize / 1024 / 1024).toFixed(1)
			} : { jsHeapMB: 'N/A', totalHeapMB: 'N/A' };
		});

		console.log(`\n=== MEMORY ===`);
		console.log(`JS Heap used:      ${mem.jsHeapMB} MB`);
		console.log(`JS Heap total:     ${mem.totalHeapMB} MB`);

		// Stop and disconnect
		console.log(`\nStopping cursor movement...`);
		intervals.forEach((id) => clearInterval(id));

		console.log(`Disconnecting ${users.length} users...`);
		const closeStart = Date.now();
		await Promise.all(users.map((u) =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, 5000); // Don't hang on close
				u.ws.on('close', () => { clearTimeout(timer); resolve(); });
				u.ws.close();
			})
		));
		console.log(`All disconnected in ${Date.now() - closeStart}ms`);

		// Health check
		await page.reload();
		await page.waitForTimeout(2000);
		const alive = await page.locator('.navbar').isVisible();

		console.log(`\n=== FINAL RESULTS ===`);
		console.log(`Connected:         ${connected}/${TOTAL} (${(connected / TOTAL * 100).toFixed(1)}%)`);
		console.log(`Failed:            ${failed}`);
		console.log(`Connect time:      ${connectTime}ms`);
		console.log(`FPS under load:    ${metrics.estimatedFPS}`);
		console.log(`p95 frame time:    ${metrics.p95}ms`);
		console.log(`App alive after:   ${alive}`);

		expect(connected / TOTAL).toBeGreaterThanOrEqual(0.9);
		expect(canvasVisible).toBe(true);
		expect(alive).toBe(true);

		await ctx.close();
	});
});
