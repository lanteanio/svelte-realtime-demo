import { test, expect } from '@playwright/test';
import {
	createBoard,
	isAppWebSocket,
	waitForAppWebSocket,
	waitForBoardReady,
	waitForWS,
	watchWire,
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

	test('a booted page that cannot connect is not relabelled a dead bundle by a stray script', async ({ page }) => {
		// The false-positive direction, which the two tests above cannot see: both
		// kill the entry bundle, so both are pages that genuinely never booted.
		//
		// The dangerous case is a page whose client IS running and whose SOCKET is
		// what failed, whilst some unrelated script happened to fail too. The wait
		// fails either way, so the reload gate is reached - and a predicate that
		// counts any failed script then calls a genuine connection failure a dead
		// bundle, reloads a live page mid-test, and burns the budget hiding the
		// real fault. That is the timeout bump wearing a disguise.
		//
		// Both conditions are required to reach the gate at all. A page that
		// connects normally never fails the wait, so it can never be reloaded no
		// matter what the predicate says - which is why the script has to be
		// paired with a broken socket to test anything.
		let documentLoads = 0;
		await page.route('**/*', (route) => {
			const request = route.request();
			if (request.resourceType() === 'document') documentLoads++;
			if (/unrelated-script\.js/.test(request.url())) return route.abort('connectionfailed');
			return route.continue();
		});
		// Injected on a timer, not at document start: an init script runs before
		// <head> exists, and appending there throws instead of requesting
		// anything. The delay also puts the failed request inside the wait's
		// window rather than racing the watcher that has to observe it.
		await page.addInitScript(() => {
			setTimeout(() => {
				const tag = document.createElement('script');
				tag.src = '/unrelated-script.js';
				(document.head ?? document.documentElement).appendChild(tag);
			}, 300);
		});
		// The client boots and builds its socket; the socket never survives. So
		// the probe sees a real connection attempt, which is exactly what makes
		// this page distinguishable from one that never ran.
		await page.routeWebSocket(/\/ws(\?|$)/, (ws) => ws.close());

		await page.goto('/', { waitUntil: 'commit' });
		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);

		expect(failure, 'a page that cannot connect must still fail the wait').not.toBeNull();
		expect(documentLoads, 'a booted page must not be reloaded').toBe(1);
		expect(failure.rehydrateReloads, 'no retry budget may be spent on a page that booted').toBe(0);
		expect(failure.message, 'a booted page must not be reported as a dead bundle').not.toContain('PAGE NEVER HYDRATED');
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

	test('a bundle that arrives and never runs is told apart from one that never arrived', async ({ page }) => {
		// Serve the entry chunk as valid, empty JavaScript: a 200 that parses,
		// executes, and does nothing. From outside, the result is identical to a
		// dead bundle - no client, no socket, a status frozen at its
		// server-rendered value - and the fix is the opposite one. Re-fetching an
		// asset that arrived intact cannot help, so a report that says "dead
		// bundle" here sends the reader to the network and spends the recovery
		// budget on the wrong thing.
		await page.route('**/_app/immutable/entry/*.js', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
		);
		await page.goto('/', { waitUntil: 'commit' });

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page with no running client must fail the wait').not.toBeNull();
		expect(failure.message).toContain('BUNDLE DELIVERED, CLIENT SILENT');
		expect(failure.message).toContain('200');
		// The two readings this one has to be told apart from. The proven wording
		// is reserved for a delivery failure and gates the reload, so reaching it
		// here would reload a page whose bundle was never the problem.
		expect(failure.message).not.toContain('PAGE NEVER HYDRATED');
		expect(failure.message).not.toContain('BUNDLE NEVER REQUESTED');
		expect(failure.rehydrateReloads, 'a delivered bundle is not fixed by re-fetching it').toBe(0);
	});

	test('a document that never asks for a client is not reported as a network fault', async ({ page }) => {
		// The third member of the family: the document itself came back without
		// the client in it. Nothing failed, nothing was slow, and there is no
		// asset to name - which is exactly why the inferred wording used to sit
		// here, describing a page that never hydrated without saying that what it
		// was served never contained a client to hydrate.
		await page.route('**/*', (route) => {
			if (route.request().resourceType() !== 'document') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: '<!doctype html><html><body><p>served without a client</p></body></html>'
			});
		});
		// Armed BEFORE the navigation. Naming the document as the fault is only
		// honest from a record that watched it load; the same verdict from a
		// record armed afterwards would be a statement about the observer.
		watchWire(page);
		await page.goto('/', { waitUntil: 'commit' });

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page with no client must fail the wait').not.toBeNull();
		expect(failure.message).toContain('BUNDLE NEVER REQUESTED');
		expect(failure.message).not.toContain('PAGE NEVER HYDRATED');
		expect(failure.message).not.toContain('BUNDLE DELIVERED');
		expect(failure.rehydrateReloads, 'there is no asset here to re-fetch').toBe(0);
	});


	test('a record armed after the navigation reads the document instead of shrugging', async ({ page }) => {
		// The same client-less document, observed the way every ordinary gate site
		// observes: navigate first, wait second. page.goto resolves on load, so by
		// the time the wait arms its record the entry chunk has already been
		// requested and answered - or, here, never requested at all - and the
		// record sees none of that traffic either way.
		//
		// The record's blindness must still not become a finding - but the
		// document is not blind about itself. Its markup says whether a client
		// was ever referenced, and its resource timeline is written by the
		// browser regardless of who was watching, so the verdict here comes from
		// the document's own evidence and says so.
		await page.route('**/*', (route) => {
			if (route.request().resourceType() !== 'document') return route.continue();
			return route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: '<!doctype html><html><body><p>served without a client</p></body></html>'
			});
		});
		await page.goto('/');

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page with no client must still fail the wait').not.toBeNull();
		expect(failure.message).toContain('BUNDLE NEVER REQUESTED');
		expect(failure.message, 'the verdict must name its source').toContain('references no client');
		// The readings this one must not reach: the delivery owner, the
		// client-executed owner, and the shrug this branch used to end in.
		expect(failure.message).not.toContain('BUNDLE DELIVERED');
		expect(failure.message).not.toContain('ENTRY CHUNK FETCH FAILED');
		expect(failure.message, 'the document answers here, so the record must not shrug').not.toContain('UNKNOWN');
		expect(failure.rehydrateReloads, 'there is no asset here to re-fetch').toBe(0);
	});

	test('an ordinary gate site tells a bundle that arrived and died from one that never arrived', async ({ page }) => {
		// The empty-but-delivered chunk again, at the ordering every real spec
		// uses: navigate first, wait second. The Playwright-side record misses
		// the fetch entirely, and the old reading here was the hedged UNKNOWN -
		// which left the most common gate failure shape covered by one sentence
		// naming three owners. The document's resource timeline holds the fetch
		// with its status, so the verdict now excludes delivery by evidence.
		await page.route('**/_app/immutable/entry/*.js', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
		);
		await page.goto('/');

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page with no running client must fail the wait').not.toBeNull();
		expect(failure.message).toContain('BUNDLE DELIVERED, CLIENT SILENT');
		expect(failure.message, 'the verdict must name its source').toContain('resource timeline');
		expect(failure.message).not.toContain('BUNDLE NEVER REQUESTED');
		expect(failure.message).not.toContain('ENTRY CHUNK FETCH FAILED');
		expect(failure.message).not.toContain('UNKNOWN');
		expect(failure.rehydrateReloads, 'a delivered bundle is not fixed by re-fetching it').toBe(0);
	});

	test('an ordinary gate site names a delivery failure it never saw, without spending the reload', async ({ page }) => {
		// The delivery-failure owner at the same ordering. The reload predicate
		// must not move: it is gated on a failure the record saw ITSELF, and
		// this record was armed after the navigation, so the verdict names the
		// fault from the document's timeline while the reload budget stays
		// unspent. Promoting timeline evidence to the proven wording would be
		// the retry firing on hearsay.
		await page.route('**/_app/immutable/entry/*.js', (route) => route.abort());
		await page.goto('/');

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page whose entry chunk never arrived must fail the wait').not.toBeNull();
		expect(failure.message).toContain('ENTRY CHUNK FETCH FAILED');
		expect(failure.message, 'the verdict must say it does not gate the reload').toContain('does not gate the recovery reload');
		expect(failure.message).not.toContain('BUNDLE DELIVERED');
		expect(failure.message).not.toContain('BUNDLE NEVER REQUESTED');
		expect(failure.message).not.toContain('UNKNOWN');
		expect(failure.rehydrateReloads, 'timeline evidence must not spend the reload budget').toBe(0);
	});

	test('a document whose timeline has been erased is reported as unknown, not accused', async ({ page }) => {
		// The honest fallback, produced rather than described. The document
		// references a client, so "never requested" would be an accusation the
		// evidence cannot support - but its resource timeline holds nothing,
		// because this test erased it, which is indistinguishable from a
		// timeline that overflowed or a browser that kept no record. The only
		// evidence-backed answer left is the hedged one, and reaching anything
		// more confident here would mean the reporter invents findings when its
		// second source goes dark too.
		await page.route('**/_app/immutable/entry/*.js', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
		);
		await page.goto('/');
		await page.evaluate(() => performance.clearResourceTimings());

		const failure = await waitForWS(page, 3000).then(() => null, (error) => error);
		expect(failure, 'a page with no running client must fail the wait').not.toBeNull();
		expect(failure.message).toContain('UNKNOWN');
		expect(failure.message, 'the hedge must say what evidence is missing').toContain('no legible entry chunk fetch');
		expect(failure.message, 'a referenced client must shield the document from accusation').not.toContain('BUNDLE NEVER REQUESTED');
		expect(failure.message).not.toContain('BUNDLE DELIVERED');
		expect(failure.message).not.toContain('ENTRY CHUNK FETCH FAILED');
		expect(failure.rehydrateReloads).toBe(0);
	});

});
