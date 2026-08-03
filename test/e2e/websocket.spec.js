import { test, expect } from '@playwright/test';
import {
	createBoard,
	isAppWebSocket,
	waitForAppWebSocket,
	waitForBoardReady,
	waitForWS,
	WS_HYDRATE_RELOADS
} from './helpers.js';

test.describe('WebSocket Connection', () => {
	test('WebSocket connects on page load', async ({ page }) => {
		const wsPromise = waitForAppWebSocket(page, { timeout: 10_000 });
		await page.goto('/');
		const ws = await wsPromise;
		expect(ws.url()).toContain('/ws');
	});

	test('WebSocket protocol matches page protocol (wss for https, ws for http)', async ({ page, baseURL }) => {
		const wsPromise = waitForAppWebSocket(page, { timeout: 10_000 });
		await page.goto('/');
		const ws = await wsPromise;
		// Production / staging serves over https -> wss. Local dev / e2e
		// against `http://localhost:NNNN` serves over http -> ws. The
		// scheme must match the page scheme, never downgrade.
		const expectedProtocol = new URL(baseURL ?? page.url()).protocol === 'https:' ? 'wss:' : 'ws:';
		expect(ws.url()).toMatch(new RegExp('^' + expectedProtocol + '//'));
	});

	test('WebSocket exchanges frames after connection', async ({ page }) => {
		let sentFrames = 0;
		let receivedFrames = 0;
		const wsPromise = waitForAppWebSocket(page, {
			timeout: 10_000,
			onOpen(ws) {
				ws.on('framesent', () => sentFrames++);
				ws.on('framereceived', () => receivedFrames++);
			}
		});
		await page.goto('/');
		await wsPromise;
		await expect.poll(() => sentFrames, { timeout: 5_000 }).toBeGreaterThan(0);
		await expect.poll(() => receivedFrames, { timeout: 5_000 }).toBeGreaterThan(0);
	});

	test('connection status shows green wifi icon when connected', async ({ page }) => {
		await page.goto('/');
		await waitForWS(page);
		await expect(page.locator('.text-success').first()).toBeVisible();
	});

	test('the connection probe re-arms per wait instead of replaying the first', async ({ page }) => {
		// 'commit' returns before the client bundle runs, so the probe is
		// installed in time to wrap the app's own WebSocket constructor. Without
		// that the socket can be built before the wrapper exists, the first
		// wait's socket list is empty, and the re-arm assertion below would pass
		// against a stale probe just as happily.
		await page.goto('/', { waitUntil: 'commit' });
		const first = await waitForWS(page);
		expect(first, 'probe must install or this test discriminates nothing').not.toBeNull();
		expect(first.sockets.length, 'first wait must have observed the app socket open').toBeGreaterThan(0);

		const second = await waitForWS(page);

		// A probe that never re-arms hands back the FIRST wait's object verbatim:
		// its clock, and its sockets. That is what made a second wait on the same
		// page - every reconnect test - report a timeline measured from a t0 long
		// in the past, against sockets that had already been accounted for.
		expect(second.t0, 're-armed probe restarts its clock').toBeGreaterThan(first.t0);
		expect(second.sockets, 'second wait opened no socket, so its list must be empty').toHaveLength(0);
	});

	test('a wait blocked by a dead app bundle reports the asset, not the socket', async ({ page }) => {
		// The failure this reproduces is the one measured in the wild: an
		// /_app/immutable/ asset lost to ERR_NO_BUFFER_SPACE, so the client never
		// booted and the page sat on its server-rendered status forever. Playwright
		// cannot inject that specific errno, but the class is what matters - a
		// failed entry chunk - and blocking it is deterministic where waiting for
		// host exhaustion is not.
		await page.route('**/_app/immutable/entry/*.js', (route) => route.abort('connectionfailed'));
		await page.goto('/', { waitUntil: 'commit' });

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'the wait must fail when the bundle never loads').not.toBeNull();
		// Naming the asset is the whole point: without it this reads as a socket
		// that never opened, which is a fault one layer down with a different fix.
		expect(failure.message).toContain('PAGE NEVER HYDRATED');
		expect(failure.message).toContain('/_app/immutable/entry/');
		expect(failure.message).toContain('failed requests:');
		// A PERSISTENT dead bundle must still fail. The retry spends its budget
		// and then reports, rather than looping or going quiet - otherwise the
		// recovery below would be indistinguishable from swallowing the fault.
		expect(failure.rehydrateReloads, 'retry budget must be spent, then the wait must fail').toBe(WS_HYDRATE_RELOADS);
	});

	test('a wait recovers from a one-off dead bundle by reloading', async ({ page }) => {
		// Kill the entry chunks on the FIRST document load only, then serve them
		// normally. That is the transient this recovery exists for: the asset is
		// fine, the host lost one fetch. Keyed on the document count rather than
		// a request counter because the entry is several files and aborting an
		// arbitrary one of them does not reliably stop hydration.
		let documentLoads = 0;
		await page.route('**/*', (route) => {
			const request = route.request();
			if (request.resourceType() === 'document') {
				documentLoads++;
				return route.continue();
			}
			if (documentLoads <= 1 && /_app\/immutable\/entry\/.*\.js/.test(request.url())) {
				return route.abort('connectionfailed');
			}
			return route.continue();
		});

		await page.goto('/', { waitUntil: 'commit' });
		const probe = await waitForWS(page, 5000);

		expect(documentLoads, 'the wait must have reloaded the dead page exactly once').toBe(2);
		expect(probe, 'a recovered wait still reports its probe').not.toBeNull();
		await expect(page.locator('.text-success').first()).toBeVisible();
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
		const wsPromise = waitForAppWebSocket(page, { timeout: 10_000 });
		await page.goto('/');
		await wsPromise;

		const boardUrl = await createBoard(page, `WS Nav ${Date.now()}`);

		await waitForWS(page);
		await expect(page.locator('.text-success').first()).toBeVisible();
	});

	test('only ONE WebSocket connection per session (no leaks)', async ({ page }) => {
		const wsConnections = [];

		page.on('websocket', (ws) => {
			if (!isAppWebSocket(ws)) return;
			const entry = { url: ws.url(), openedAt: Date.now(), closed: false };
			wsConnections.push(entry);
			ws.on('close', () => {
				entry.closed = true;
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
			if (!isAppWebSocket(ws)) return;
			const entry = { url: ws.url(), closed: false };
			wsConnections.push(entry);
			ws.on('close', () => {
				entry.closed = true;
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
