/**
 * Standalone destroyer -- runs without Playwright.
 * Pure Node.js + ws library. Connect, join presence, optionally move cursors.
 * Ramps through levels and reports results.
 *
 * Usage:
 *   node destroyer.js                          # presence only
 *   node destroyer.js --cursors                # with cursor movement
 *   node destroyer.js --url wss://localhost/ws # custom server
 */

import { WebSocket } from 'ws';
const args = process.argv.slice(2);
const WITH_CURSORS = args.includes('--cursors');
const WS_URL = args.find(a => a.startsWith('wss://')) || 'wss://svelte-realtime-demo.lantean.io/ws';
const HTTP_URL = WS_URL.replace('wss://', 'https://').replace('/ws', '');
const BOARD_SLUG = 'stress-me-out';
const LEVELS = [1000, 2000, 3000, 5000, 7000, 10000];

// Disable TLS verification for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let msgId = 0;
const nextId = () => 'x' + (msgId++).toString(36);

// Resolve board UUID from the page HTML
async function getBoardId() {
	try {
		const res = await fetch(`${HTTP_URL}/board/${BOARD_SLUG}`);
		const body = await res.text();
		const match = body.match(/boardId[:"]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		if (match) return match[1];
	} catch (err) {
		// Some servers send duplicate Content-Length which strict HTTP parsers reject.
		// Extract boardId from the error data if available.
		const raw = err?.cause?.data || '';
		const match = raw.match?.(/boardId[:"]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		if (match) return match[1];
	}
	throw new Error('Could not find boardId in page');
}

function connectUser(index) {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({
			id, name: `X${index}`, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
		}))}`;

		const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie }, rejectUnauthorized: false });
		const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 20000);

		ws.on('open', () => { clearTimeout(timer); resolve({ ws, index }); });
		ws.on('error', () => { clearTimeout(timer); reject(new Error('error')); });
	});
}

function joinBoard(ws, boardId) {
	try { ws.send(JSON.stringify({ rpc: 'boards/cursors/joinBoard', id: nextId(), args: [boardId] })); } catch {}
}

function startCursor(ws, boardId) {
	let x = 50 + Math.random() * 1100, y = 50 + Math.random() * 550;
	let vx = (Math.random() - 0.5) * 8, vy = (Math.random() - 0.5) * 8;

	return setInterval(() => {
		x += vx; y += vy;
		if (x < 10 || x > 1200) vx = -vx;
		if (y < 10 || y > 650) vy = -vy;
		x = Math.max(10, Math.min(1200, x));
		y = Math.max(10, Math.min(650, y));
		vx = Math.max(-12, Math.min(12, vx + (Math.random() - 0.5) * 1.5));
		vy = Math.max(-12, Math.min(12, vy + (Math.random() - 0.5) * 1.5));

		try {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ rpc: 'boards/cursors/moveCursor', id: nextId(), args: [boardId, { x: Math.round(x), y: Math.round(y) }] }));
			}
		} catch {}
	}, 32);
}

async function checkServer() {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		const res = await fetch(`${HTTP_URL}/board/${BOARD_SLUG}`, { signal: controller.signal });
		clearTimeout(timer);
		return res.status === 200;
	} catch (err) {
		// Duplicate Content-Length is a protocol error but means the server IS responding
		if (err?.cause?.code === 'HPE_UNEXPECTED_CONTENT_LENGTH' || err?.cause?.data) return true;
		return false;
	}
}

async function run() {
	console.log('='.repeat(60));
	console.log(`  DESTROYER (standalone) -- ${WITH_CURSORS ? 'with cursors' : 'presence only'}`);
	console.log(`  Target: ${WS_URL}`);
	console.log(`  Board:  ${BOARD_SLUG}`);
	console.log(`  Levels: ${LEVELS.join(', ')}`);
	console.log('='.repeat(60) + '\n');

	const boardId = await getBoardId();
	console.log(`  Board UUID: ${boardId}\n`);

	const allUsers = [];
	const allIntervals = [];
	let lastStable = 0;

	for (const target of LEVELS) {
		const toAdd = target - allUsers.length;
		console.log(`--- Level ${target} (adding ${toAdd}) ---`);

		let ok = 0, fail = 0;
		const t0 = Date.now();

		for (let batch = 0; batch < toAdd; batch += 100) {
			const end = Math.min(batch + 100, toAdd);
			const promises = [];
			for (let i = batch; i < end; i++) {
				promises.push(
					connectUser(allUsers.length + i)
						.then((u) => { allUsers.push(u); ok++; })
						.catch(() => { fail++; })
				);
			}
			await Promise.all(promises);
			await new Promise((r) => setTimeout(r, 50));
		}

		const elapsed = Date.now() - t0;
		const rate = ((ok / (ok + fail)) * 100).toFixed(1);
		console.log(`  Connected: ${ok} new, ${fail} failed (${rate}%)`);
		console.log(`  Total: ${allUsers.length}`);
		console.log(`  Time: ${elapsed}ms (${(elapsed / Math.max(toAdd, 1)).toFixed(1)}ms/user)`);

		// Join presence for new users
		const newUsers = allUsers.slice(allUsers.length - ok);
		for (const u of newUsers) {
			joinBoard(u.ws, boardId);
			if (WITH_CURSORS) allIntervals.push(startCursor(u.ws, boardId));
		}

		// Let it settle
		await new Promise((r) => setTimeout(r, 3000));

		const alive = await checkServer();
		console.log(`  Server alive: ${alive}`);

		if (!alive) { console.log(`\n  STOPPED: server unresponsive at ${target}`); break; }
		if (ok / Math.max(ok + fail, 1) < 0.5) { console.log(`\n  STOPPED: join rate below 50% at ${target}`); break; }

		lastStable = target;
		console.log(`  PASSED\n`);
	}

	// Cleanup
	console.log('--- Cleanup ---');
	allIntervals.forEach((id) => clearInterval(id));
	console.log(`Disconnecting ${allUsers.length} users...`);
	const t0 = Date.now();
	await Promise.all(allUsers.map((u) =>
		new Promise((resolve) => {
			const timer = setTimeout(resolve, 5000);
			u.ws.on('close', () => { clearTimeout(timer); resolve(); });
			u.ws.close();
		})
	));
	console.log(`Done in ${Date.now() - t0}ms`);

	await new Promise((r) => setTimeout(r, 2000));
	const finalAlive = await checkServer();

	console.log(`\n${'='.repeat(60)}`);
	console.log(`  RESULTS`);
	console.log(`  Last stable: ${lastStable}`);
	console.log(`  Server alive after: ${finalAlive}`);
	console.log('='.repeat(60) + '\n');

	process.exit(lastStable >= 1000 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
