/**
 * Standalone destroyer - runs without Playwright.
 * Pure Node.js + ws library. Connect, join presence, optionally move cursors.
 * Ramps through levels and reports results.
 *
 * Single-process default. With WORKERS=N (N > 1) the primary process forks
 * N child Node processes via the cluster module, divides LEVELS by N, and
 * aggregates exit codes. Each child runs a separate event loop, which
 * bypasses single-process setInterval saturation: at WORKERS=1 with 1000
 * bots at 8ms, the harness only delivers ~12 RPCs/sec/bot because the
 * 1000 timers compete for one event loop. With WORKERS=8 each child has
 * 125 timers and the harness can hit the configured rate.
 *
 * Usage:
 *   node destroyer.js                          # presence only
 *   node destroyer.js --cursors                # with cursor movement
 *   node destroyer.js --url wss://localhost/ws # custom server
 *
 *   WORKERS=8 LEVELS=1000 CURSOR_INTERVAL_MS=8 SUSTAIN_MS=60000 \
 *     node destroyer-standalone.js --cursors
 */

import cluster from 'node:cluster';
import { WebSocket } from 'ws';
import {
	assertSafeE2ETarget,
	resolveE2EBaseURL,
	toWebSocketURL
} from '../scripts/test-target.mjs';

const args = process.argv.slice(2);
const WITH_CURSORS = args.includes('--cursors');
const urlFlag = args.indexOf('--url');
const explicitUrl = args.find((arg) => arg.startsWith('--url='))?.slice('--url='.length)
	|| (urlFlag >= 0 ? args[urlFlag + 1] : null)
	|| args.find((arg) => /^(?:ws|wss):\/\//.test(arg));
const WS_URL = explicitUrl
	? assertSafeE2ETarget(explicitUrl).href
	: toWebSocketURL(resolveE2EBaseURL());
const httpTarget = new URL(WS_URL);
httpTarget.protocol = httpTarget.protocol === 'wss:' ? 'https:' : 'http:';
httpTarget.pathname = '';
httpTarget.search = '';
httpTarget.hash = '';
const HTTP_URL = httpTarget.href.replace(/\/$/, '');
const BOARD_SLUG = 'stress-me-out';

// Multi-process: WORKERS=N forks N child Node processes that each handle
// 1/N of the bot population. Default 1 = single-process (legacy behavior).
// SHARD is set per child by the primary (0..N-1); 0 in single-process mode.
const WORKERS = Math.max(1, parseInt(process.env.WORKERS, 10) || 1);
const SHARD = parseInt(process.env.SHARD, 10) || 0;
// Each shard reserves 100k bot indices so display names stay globally
// unique across children (the user id is randomUUID and already unique;
// this is just for log readability).
const SHARD_BASE = SHARD * 100_000;

// Ramps past 10K to find the actual ceiling when fired from a Linux box
// against the demo (home networks NAT-table-out around 5-10K). Override via
// LEVELS env var: `LEVELS=1000,5000,15000,30000 node destroyer-standalone.js`.
const LEVELS = process.env.LEVELS
	? process.env.LEVELS.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
	: [1000, 2000, 5000, 10000, 15000, 20000, 30000, 50000];

// Per-bot cursor publish interval (ms). 32ms (~31Hz) keeps headroom; 8ms
// (~125Hz) saturates the server's 8ms cursor throttle from every bot.
// At N bots x 125Hz that's N*125 raw RPCs/sec landing on the publish path
// before per-WS coalescing kicks in -- the real ceiling-finding workload.
//
//   CURSOR_INTERVAL_MS=8 node destroyer-standalone.js --cursors    # PARTY MODE
const CURSOR_INTERVAL_MS = Number.isFinite(parseInt(process.env.CURSOR_INTERVAL_MS, 10))
	? parseInt(process.env.CURSOR_INTERVAL_MS, 10)
	: 32;

// Hold time (ms) after each level's ramp completes, before either moving to
// the next level or running cleanup on the last level. Default 3s for
// ceiling-finding ramps; bump for sustained-load probes, e.g.
//   LEVELS=1000 SUSTAIN_MS=120000   # hold 1000 cursors for 2 minutes
const SUSTAIN_MS = Number.isFinite(parseInt(process.env.SUSTAIN_MS, 10))
	? parseInt(process.env.SUSTAIN_MS, 10)
	: 3000;

if (WORKERS > 1 && cluster.isPrimary) {
	runPrimary();
} else {
	if (WORKERS > 1) {
		// Prefix every child log line with its shard id so interleaved output
		// from multiple workers stays readable in one terminal.
		const origLog = console.log;
		console.log = (msg = '', ...rest) => origLog(`[s${SHARD}] ${msg}`, ...rest);
	}
	runChild().catch((err) => { console.error(err); process.exit(1); });
}

// ============================================================
// Primary: fork N children, divide LEVELS across them
// ============================================================

function runPrimary() {
	const childLevels = LEVELS.map((n) => Math.floor(n / WORKERS)).filter((n) => n > 0).join(',');

	console.log('='.repeat(60));
	console.log(`  DESTROYER (multi-process) - ${WORKERS} workers - ${WITH_CURSORS ? 'with cursors' : 'presence only'}`);
	console.log(`  Target:           ${WS_URL}`);
	console.log(`  Board:            ${BOARD_SLUG}`);
	console.log(`  Global LEVELS:    ${LEVELS.join(', ')}`);
	console.log(`  Per-shard LEVELS: ${childLevels}`);
	if (WITH_CURSORS) {
		const hz = (1000 / CURSOR_INTERVAL_MS).toFixed(1);
		console.log(`  Cursor rate:      ${CURSOR_INTERVAL_MS}ms (~${hz}Hz per bot)`);
	}
	console.log(`  Sustain:          ${SUSTAIN_MS}ms per level`);
	console.log('='.repeat(60));

	const start = Date.now();
	let exits = 0;
	let failures = 0;

	for (let i = 0; i < WORKERS; i++) {
		cluster.fork({ ...process.env, SHARD: String(i), LEVELS: childLevels });
	}

	cluster.on('exit', (worker, code) => {
		exits++;
		if (code !== 0) failures++;
		if (exits === WORKERS) {
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			console.log('='.repeat(60));
			console.log(`  All ${WORKERS} workers exited (${failures} failures) in ${elapsed}s`);
			console.log('='.repeat(60));
			process.exit(failures > 0 ? 1 : 0);
		}
	});
}

// ============================================================
// Child: existing single-process destroyer logic
// ============================================================

let msgId = 0;
const nextId = () => 'x' + (msgId++).toString(36);

// Resolve board UUID. Env override (BOARD_UUID=<uuid>) skips the page
// fetch entirely -- needed when running from a remote box where undici
// rejects the page response with UND_ERR_INVALID_ARG (uWS's response
// headers can confuse strict HTTP parsers).
async function getBoardId() {
	if (process.env.BOARD_UUID && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(process.env.BOARD_UUID)) {
		return process.env.BOARD_UUID;
	}
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
	throw new Error('Could not find boardId in page; pass BOARD_UUID=<uuid> env to skip auto-detect.');
}

function connectUser(index) {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const cookie = `identity=${encodeURIComponent(JSON.stringify({
			id, name: `X${SHARD_BASE + index}`, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
		}))}`;

		const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie }, rejectUnauthorized: false });
		const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 60000);

		ws.on('open', () => { clearTimeout(timer); resolve({ ws, index }); });
		ws.on('error', () => { clearTimeout(timer); reject(new Error('error')); });
	});
}

// Blind-retry joinBoard up to 3 times spaced ~1-4s apart. The demo's
// `boards/cursors/joinBoard` is in the `background` admission class so it
// gets shed with OVERLOADED under PUBLISH_RATE pressure during mass
// connect. presence.join + cursor.attach are both idempotent (already-
// joined returns early), so a redundant successful call after a shed
// rejection costs only the wire frame, not server state churn. Without
// this, fire-and-forget bots from rejected attempts permanently stay
// outside per-board presence even though their WS is live.
function joinBoard(ws, boardId) {
	const send = () => {
		try { ws.send(JSON.stringify({ rpc: 'boards/cursors/joinBoard', id: nextId(), args: [boardId] })); } catch {}
	};
	send();
	setTimeout(send, 1000 + Math.random() * 1000);
	setTimeout(send, 3000 + Math.random() * 1000);
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
	}, CURSOR_INTERVAL_MS);
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

async function runChild() {
	console.log('='.repeat(60));
	console.log(`  DESTROYER ${WORKERS > 1 ? `(shard ${SHARD}/${WORKERS})` : '(standalone)'} - ${WITH_CURSORS ? 'with cursors' : 'presence only'}`);
	console.log(`  Target: ${WS_URL}`);
	console.log(`  Board:  ${BOARD_SLUG}`);
	console.log(`  Levels: ${LEVELS.join(', ')}`);
	if (WITH_CURSORS) {
		const hz = (1000 / CURSOR_INTERVAL_MS).toFixed(1);
		console.log(`  Cursor rate: ${CURSOR_INTERVAL_MS}ms (~${hz}Hz per bot)`);
	}
	console.log(`  Sustain: ${SUSTAIN_MS}ms per level`);
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

		const BATCH = 25;
		for (let batch = 0; batch < toAdd; batch += BATCH) {
			const end = Math.min(batch + BATCH, toAdd);
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

		// Hold steady at this level (settle for ramps, sustained load for probes)
		await new Promise((r) => setTimeout(r, SUSTAIN_MS));

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

	process.exit(lastStable >= LEVELS[0] ? 0 : 1);
}
