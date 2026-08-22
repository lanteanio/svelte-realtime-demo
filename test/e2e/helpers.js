/**
 * Shared helpers for E2E tests
 */

import { expect } from '@playwright/test';
import { applyWireFrame, createWireRecord, formatWire } from './wire-report.js';

export { formatWire } from './wire-report.js';

/** How long a page gets to show a connected socket before the wait fails. */
export const WS_CONNECT_TIMEOUT = 15000;

/** Above this, a connect is logged as a near miss even though it passed. */
export const WS_SLOW_CONNECT = 2000;

/**
 * How many times a wait re-loads a page it has PROVEN never hydrated.
 *
 * One. The fault this recovers from is a host-level transient in the loopback
 * path - measured firing at 2.6% ephemeral-port use, on a freshly started
 * browser, so neither port exhaustion nor accumulated browser state explains
 * it, and nothing in this repo can remove it. A single reload clears a
 * transient; a second would only be papering over something persistent, which
 * is a finding rather than something to retry past.
 */
export const WS_HYDRATE_RELOADS = 1;

/**
 * Installed into the page at the start of every connection wait.
 *
 * Records two things a bare selector timeout cannot distinguish:
 *
 * - the connection-status timeline, sampled rather than observed, because the
 *   navbar swaps the whole icon element between Wifi and WifiOff across a
 *   status change and a MutationObserver bound to the old node would go deaf
 *   at exactly the transition we care about;
 * - every WebSocket the page opens, and how each one ended. The adapter builds
 *   its socket with a bare `new WebSocket(...)` global lookup per attempt
 *   (svelte-adapter-uws/src/client.js:1390), so wrapping the constructor after
 *   load still captures all subsequent attempts.
 *
 * Together these separate "the server never accepted the socket" from "the
 * client was parked in its own reconnect backoff". Those look identical in a
 * timeout screenshot and have opposite fixes.
 */
function installConnectionProbe() {
	// Re-arm rather than bail out. Every wait ends by stopping the sampler, but
	// the probe object stays on the page, so a second wait on the same page - a
	// reconnect test, a repeated navigation - used to get the FIRST wait's
	// timeline with every timestamp measured from a t0 that could be minutes in
	// the past, and no samples at all after the first cleanup. Resetting the
	// same object rather than building a new one keeps the single WebSocket
	// wrapper installed: wrapping again per wait would nest the constructors,
	// and each nested layer would record into whichever probe it had closed
	// over instead of the live one.
	if (window.__wsProbe) {
		window.__wsProbe.rearm();
		return;
	}
	// Whether something had ALREADY replaced the constructor before this probe
	// did. Playwright installs `class WebSocket extends WebSocketMock` when a
	// spec routes the socket, and under that the frames observable from outside
	// the page belong to the relay rather than to the page. Read once here,
	// before the wrapper below makes the two indistinguishable.
	const routed = !String(window.WebSocket).includes('[native code]');
	const probe = { t0: performance.now(), routed, states: [], sockets: [] };
	window.__wsProbe = probe;
	const since = () => Math.round(performance.now() - probe.t0);

	const readState = () => {
		const control = document.querySelector('[aria-label^="Connection status"]');
		if (!control) return 'no-indicator';
		const tone = (control.querySelector('svg')?.getAttribute('class') ?? '').match(/text-(success|warning|error)/);
		const label = (control.getAttribute('aria-label') ?? '').replace('Connection status: ', '');
		return `${label} (${tone ? tone[0] : 'no-tone'})`;
	};
	const sample = () => {
		const state = readState();
		if (probe.states[probe.states.length - 1]?.state !== state) probe.states.push({ at: since(), state });
	};
	probe.rearm = () => {
		if (probe.timer) clearInterval(probe.timer);
		probe.t0 = performance.now();
		probe.states = [];
		probe.sockets = [];
		sample();
		probe.timer = setInterval(sample, 100);
	};
	probe.rearm();

	const Native = window.WebSocket;
	const Wrapped = function (url, protocols) {
		const socket = protocols === undefined ? new Native(url) : new Native(url, protocols);
		const entry = { at: since(), url: String(url) };
		probe.sockets.push(entry);
		socket.addEventListener('open', () => { entry.opened = since(); });
		socket.addEventListener('error', () => { entry.errored = since(); });
		socket.addEventListener('close', (event) => {
			entry.closed = since();
			entry.code = event.code;
			entry.reason = event.reason;
			entry.wasClean = event.wasClean;
		});
		return socket;
	};
	// The adapter reads WebSocket.CONNECTING/OPEN off the global to decide
	// whether a connect is already in flight, so the wrapper has to carry the
	// readyState constants or every attempt would look idle and re-enter.
	Wrapped.prototype = Native.prototype;
	Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = Wrapped;
}

/**
 * Watch the faults a page cannot report about itself.
 *
 * The in-page probe can only describe a page whose JavaScript is running. When
 * the client bundle never loads there is nothing in the page to ask, and the
 * evidence lives entirely on the Playwright side: a failed request for an
 * `/_app/immutable/` asset, and the module-import error the browser raises
 * afterwards. That pair is what a hydration failure looks like from outside,
 * and without capturing it a wait can only report the symptom - a socket that
 * never appeared - about a page that never got as far as opening one.
 */
function watchPageFaults(page) {
	const faults = { requests: [], errors: [] };
	const onRequestFailed = (request) => {
		faults.requests.push({
			url: request.url(),
			type: request.resourceType(),
			failure: request.failure()?.errorText ?? 'unknown failure'
		});
	};
	const onPageError = (error) => faults.errors.push(error.message);
	page.on('requestfailed', onRequestFailed);
	page.on('pageerror', onPageError);
	return {
		faults,
		stop() {
			page.off('requestfailed', onRequestFailed);
			page.off('pageerror', onPageError);
		}
	};
}

/**
 * An aborted request is the page or the test cancelling it - a navigation away,
 * a fetch a spec deliberately interrupts - and never the host running out of
 * anything. `/demos/denials` alone produces three per run. Counting those as
 * evidence would fill the diagnostic channel with normal behaviour, which is
 * the same way a gate with a false-failure rate trains people to ignore it.
 */
function isDeliberateAbort(fault) {
	return fault.failure === 'net::ERR_ABORTED';
}

/**
 * DIRECT evidence that the client bundle never loaded, as a reason string.
 *
 * Kept separate from the inferred reading below because this is the predicate
 * the retry is gated on, and only proof may gate a retry. A failed script
 * request is a fact about the network; "no socket appeared and the status never
 * moved" is a deduction that a genuinely broken connection satisfies just as
 * well, and retrying on that would be the timeout bump wearing a disguise.
 */
function provenHydrationFailure(faults) {
	// The ENTRY chunks only, and never an abort. Three exclusions, each of which
	// would otherwise let a live page be reloaded out from under a running test:
	//
	// - Any `script`. A page that is already hydrated can lose an unrelated or
	//   lazily-injected script and carry on; that is a fact about one request,
	//   not proof the client never booted.
	// - Any `/_app/**.js`. A route chunk failing does stop THAT route hydrating,
	//   but the browser raises "failed to fetch dynamically imported module" when
	//   it does, and the error branch below already catches it with proof.
	// - A stylesheet under /_app/, which does not stop the client booting.
	//
	// What is left is the one request whose failure cannot mean anything else:
	// the entry bundle the document loads to start SvelteKit at all. This is
	// what keeps the reload gated on proof rather than on a symptom, and the
	// reload's safety argument depends on that exactness - a page whose bundle
	// never ran has no client state to lose, but a live one does.
	const assetFailures = faults.requests.filter(
		(r) => !isDeliberateAbort(r) && /\/_app\/immutable\/entry\/[^/]+\.js($|\?)/.test(r.url)
	);
	if (assetFailures.length) return `${assetFailures[0].failure} loading ${assetFailures[0].url}`;
	const importErrors = faults.errors.filter((m) => /dynamically imported module|module script failed/i.test(m));
	if (importErrors.length) return importErrors[0];
	return null;
}

/**
 * Name a hydration failure outright instead of leaving it to be inferred.
 *
 * Returns null when the evidence does not support the call - a wait that failed
 * for some other reason must not be mislabelled, since 'the page never booted'
 * and 'the page booted and could not connect' have opposite fixes.
 */
function diagnoseHydration(probe, faults) {
	const proven = provenHydrationFailure(faults);
	if (proven) return `PAGE NEVER HYDRATED: ${proven}`;
	// No direct evidence, so fall back to the shape a dead bundle leaves behind:
	// the client constructs its socket as soon as it boots, and the navbar only
	// moves off the server-rendered status once a store updates. Neither
	// happening means nothing ran. Hedged deliberately - this one is inferred.
	const appSockets = (probe?.sockets ?? []).filter((s) => isAppSocketUrl(s.url));
	if (probe && appSockets.length === 0 && probe.states.length <= 1) {
		return 'PAGE LIKELY NEVER HYDRATED: no app socket was constructed and the status never left its server-rendered value.';
	}
	return null;
}

/** Render the probe's findings for a failure message. */
function formatConnectionProbe(probe, faults) {
	if (!probe) return 'probe did not install';
	const states = probe.states.map((s) => `${s.at}ms ${s.state}`).join(' -> ') || '(none captured)';
	const sockets = probe.sockets.length
		? probe.sockets.map((s, i) => {
			const ended = s.closed === undefined
				? (s.errored === undefined ? 'still pending' : `errored at ${s.errored}ms, never closed`)
				: `closed at ${s.closed}ms code=${s.code} clean=${s.wasClean}${s.reason ? ` reason=${s.reason}` : ''}`;
			// The URL is load-bearing, not decoration. In dev the page also holds
			// Vite's HMR socket (ws://host/?token=...), which opens immediately
			// and never closes. Without the URL that socket is indistinguishable
			// from the app's own socket (path /ws) having opened, and those two
			// readings point at completely different faults: an app that never
			// connected versus an app whose connection was ignored.
			return `  #${i + 1} ${s.url}\n      attempt at ${s.at}ms, ${s.opened === undefined ? 'never reached open' : `open at ${s.opened}ms`}, ${ended}`;
		}).join('\n')
		: '  (no WebSocket constructed during the wait)';
	const sections = [`status timeline: ${states}`, `socket attempts:\n${sockets}`];
	if (faults?.requests.length) {
		sections.push(`failed requests:\n${faults.requests.map((r) => `  ${r.failure} ${r.type} ${r.url}`).join('\n')}`);
	}
	if (faults?.errors.length) {
		sections.push(`page errors:\n${faults.errors.map((m) => `  ${m}`).join('\n')}`);
	}
	const verdict = faults ? diagnoseHydration(probe, faults) : null;
	if (verdict) sections.unshift(verdict);
	return sections.join('\n');
}

/**
 * Wait for the WebSocket to be connected (green wifi icon visible).
 *
 * A timeout here means the client genuinely held a non-open socket for the
 * whole budget, since the navbar only paints `.text-success` for the 'open'
 * and 'suspended' states. That makes the wait an honest signal but a useless
 * report, so a failure is enriched with the connection probe above.
 *
 * Returns the probe snapshot for THIS wait, which is also what lets a test
 * prove the probe re-armed rather than replaying an earlier wait's timeline.
 *
 * A page that provably never loaded its client bundle is reloaded once and
 * waited for again - see `WS_HYDRATE_RELOADS` for why that is a recovery and
 * not a way of making a real failure quiet.
 */
export async function waitForWS(page, timeout = WS_CONNECT_TIMEOUT) {
	// ONE watcher for the whole call, not one per attempt. The reload happens
	// BETWEEN attempts, and a dead bundle's failed requests fire during it - so
	// a per-attempt watcher sees an empty fault list on the retry and the final
	// report degrades from naming the asset to merely inferring a dead page.
	// That is precisely the loss of evidence this instrumentation exists to
	// prevent, and it only shows up once a retry actually happens.
	// Arm the wire record here too, not only at the navigation sites that own
	// their own goto. This is the earliest point every existing gate already
	// shares, and the record reports its own completeness, so arming it late
	// degrades to "no evidence" rather than to a confident wrong answer.
	const wire = watchWire(page);
	const watcher = watchPageFaults(page);
	try {
		for (let reloads = 0; ; reloads++) {
			const attempt = await attemptConnectionWait(page, timeout);
			// Carried across from the in-page probe, which is the only place the
			// check can be made: once the probe has wrapped the constructor, a
			// routed page and an instrumented one look alike from the outside.
			if (attempt.probe?.routed) wire.routed = true;
			// Reload only on PROOF that the client bundle never loaded, and only
			// within the budget. Two things make this a recovery rather than a
			// failure mask. It fires on a fact - a
			// failed script request - not on a bare timeout, so a genuine 15s
			// connect stall still fails as loudly as before. And a page whose
			// bundle never ran has no client-side state to lose, so reloading is
			// safe even mid-test: any state the spec established is either
			// server-side and survives, or was never created at all.
			const proven = attempt.failure && provenHydrationFailure(watcher.faults);
			if (proven && reloads < WS_HYDRATE_RELOADS) {
				console.log(`[ws-rehydrate] ${page.url()} never hydrated (${proven}); reloading, attempt ${reloads + 1} of ${WS_HYDRATE_RELOADS}`);
				// A reload that itself fails is not worth its own error path: the
				// next attempt fails the same way and reports the whole history.
				await page.reload().catch(() => {});
				continue;
			}
			return finishConnectionWait(page, { ...attempt, faults: watcher.faults }, reloads);
		}
	} finally {
		watcher.stop();
	}
}

/** One pass of the wait: arm the probe, watch, and collect what it saw. */
async function attemptConnectionWait(page, timeout) {
	await page.evaluate(installConnectionProbe).catch(() => { /* pre-hydration; the wait still stands on its own */ });
	const started = Date.now();
	let failure = null;
	try {
		await page.locator('.text-success').first().waitFor({ state: 'visible', timeout });
	} catch (error) {
		failure = error;
	}
	const elapsed = Date.now() - started;
	// `rearm` is a function and does not survive serialisation, so hand back a
	// plain snapshot rather than the probe itself.
	const probe = await page.evaluate(() => {
		const found = window.__wsProbe ?? null;
		if (found?.timer) clearInterval(found.timer);
		return found && { t0: found.t0, routed: found.routed, states: found.states, sockets: found.sockets };
	}).catch(() => null);
	return { probe, failure, elapsed };
}

/** Report the outcome of the final attempt, and throw if it failed. */
function finishConnectionWait(page, { probe, faults, failure, elapsed }, reloads) {
	// Never let a recovered wait pass silently. A run's log has to show how
	// often this fired, or a rising rate of a host fault becomes invisible
	// exactly the way the original false-failure rate was.
	const after = reloads ? ` after ${reloads} rehydrate reload(s)` : '';
	if (failure) {
		failure.message = `${failure.message}\n\n--- connection probe (${elapsed}ms${after}) ---\n${formatConnectionProbe(probe, faults)}`;
		// Carry the structured probe on the error too. A failure is exactly when
		// a caller most wants the socket list, and a thrown wait has no return
		// value to put it in.
		failure.probe = probe;
		failure.faults = faults;
		failure.rehydrateReloads = reloads;
		throw failure;
	}
	if (reloads) {
		console.log(`[ws-rehydrate] ${page.url()} connected in ${elapsed}ms${after}`);
	}
	// Report the slow tail, not just the outright failures. A measured 60-open
	// sample put this connect at p99 425ms against a 15000ms budget, so the
	// budget is not the thing under strain and a plain pass/fail gate throws
	// away every near miss. Anything past this threshold is a multiple of the
	// whole observed distribution and is worth a line in the run log, so one
	// clean run still produces evidence instead of only a coin flip on whether
	// the rare hard failure happened to fire.
	if (elapsed > WS_SLOW_CONNECT) {
		console.log(`[ws-slow] ${page.url()} connected after ${elapsed}ms\n${formatConnectionProbe(probe, faults)}`);
	} else if (!reloads) {
		// A wait that PASSED while a request failed underneath it is the near
		// miss that matters most here: the browser retried an asset and won,
		// which is the same resource exhaustion that loses the race when it
		// does not. A pass/fail gate discards exactly this evidence, so a run
		// with no hard failure still measures how close the host came. Skipped
		// after a rehydrate reload, which has already reported the same faults.
		const nearMisses = faults.requests.filter((r) => !isDeliberateAbort(r));
		if (nearMisses.length) {
			console.log(`[ws-fault] ${page.url()} connected in ${elapsed}ms despite:\n${nearMisses.map((r) => `  ${r.failure} ${r.type} ${r.url}`).join('\n')}`);
		}
	}
	return probe;
}

async function answerDestructiveConfirmation(locator, accept, clickOptions, { undoable = false } = {}) {
	const page = locator.page();
	const dialogPromise = page.waitForEvent('dialog');
	// A click on a confirm-gated control cannot settle until the dialog is
	// answered, so the click can only win this race by failing outright - or by
	// there being no gate at all. Racing does two things a bare `await
	// dialogPromise` did not: a click rejection surfaces here instead of as an
	// unhandled rejection while we are still parked on the event, and a control
	// that has silently LOST its confirm gate fails loudly and immediately
	// rather than stalling until the default event timeout.
	let clickError = null;
	const clickPromise = locator.click(clickOptions).catch((err) => { clickError = err; });
	const dialog = await Promise.race([dialogPromise, clickPromise.then(() => null)]);
	if (!dialog) {
		throw clickError ?? new Error(
			'Destructive control click completed without a confirmation dialog: the confirmDestructive gate is missing.'
		);
	}
	const message = dialog.message();
	// The consequence clause is asserted in BOTH directions: a surface that
	// offers an undo must not claim the change is permanent, and the far more
	// common permanent surface must not quietly soften its wording. Checking
	// only the shared prefix would let either one drift unnoticed.
	const consequence = undoable ? 'You can undo it for a few seconds' : 'cannot be undone';
	const valid = dialog.type() === 'confirm'
		&& message.includes('shared demo state for everyone')
		&& message.includes(consequence);
	if (accept) await dialog.accept();
	else await dialog.dismiss();
	await clickPromise;
	if (clickError) throw clickError;
	if (!valid) throw new Error(`Unexpected destructive confirmation: ${dialog.type()} ${message}`);
	return message;
}

/**
 * Click a destructive control and accept its shared-state confirmation.
 * Pass `{ undoable: true }` for a surface whose gate promises an undo.
 */
export function confirmAndClick(locator, clickOptions, options) {
	return answerDestructiveConfirmation(locator, true, clickOptions, options);
}

/** Click a destructive control and cancel its shared-state confirmation. */
export function dismissConfirmation(locator, clickOptions, options) {
	return answerDestructiveConfirmation(locator, false, clickOptions, options);
}

/**
 * Clone a context's storage state for a second context that must share the
 * SAME identity.
 *
 * `+layout.server.js` sets the identity cookie `secure: !dev`, so a prod-build
 * server - which is what the local e2e harness runs - marks it Secure even on
 * http://localhost. `storageState()` round-trips that flag verbatim, and
 * browsers refuse to send a Secure cookie over http://, so the second context
 * silently mints a FRESH session instead of inheriting the first one. Every
 * same-user assertion downstream (cross-tab push, one-identity-counts-once)
 * then tests the wrong thing. Strip the flag unless the target really is https.
 */
export async function sharedIdentityState(context, targetUrl = process.env.BASE_URL) {
	const state = await context.storageState();
	if (String(targetUrl ?? '').startsWith('https://')) return state;
	return { ...state, cookies: state.cookies.map((c) => ({ ...c, secure: false })) };
}

/** True only for the application's realtime socket URL, never Vite's HMR socket. */
function isAppSocketUrl(url) {
	try {
		return new URL(url).pathname === '/ws';
	} catch {
		return false;
	}
}

/** True only for the application's realtime socket, never Vite's HMR socket. */
export function isAppWebSocket(ws) {
	return isAppSocketUrl(ws.url());
}

/** Wire records belong to a page and outlive the wait that installed them. */
const wireRecords = new WeakMap();

/** Frames are either JSON or a codec's binary payload; only JSON is readable here. */
function parseWireFrame(payload) {
	if (typeof payload !== 'string') return null;
	try {
		const parsed = JSON.parse(payload);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Record what a page ASKED the server for, and what came back.
 *
 * The connection probe answers "did a socket open". Once it has said yes, every
 * remaining explanation for a content wait that times out lives one layer up,
 * in the page's subscriptions - and none of that is captured anywhere, so the
 * failure arrives as a bare locator timeout that names the element and nothing
 * else. These are ordinary JSON frames that Playwright can read without
 * touching the page, which is why this watches from outside rather than
 * instrumenting the client.
 *
 * The shape below is measured off a live page, not read from the adapter:
 *
 *   out {"rpc":"demos/flash-sales/productList","id":"a1","args":[],"stream":true}
 *   out {"batch":[{"rpc":"...","id":"a2","stream":true}, ...]}
 *   in  {"topic":"__rpc","event":"a1","data":{"id":"a1","ok":true,"data":[...],"topic":"demos:flash-sales:products"}}
 *   in  {"topic":"__rpc","event":"__batch","data":{"batch":[{"id":"a2","ok":true,...}]}}
 *   in  {"topic":"demos:flash-sales:products","event":"update","data":{...}}
 *
 * A request, its answer, and the deliveries that follow are therefore three
 * distinguishable things, which is what lets a failed wait say WHICH of them
 * never happened. Those have opposite fixes: a request never sent is the client
 * never reaching its subscribe, an unanswered one is the server, and an
 * answered one means the data arrived and the page failed to render it.
 *
 * One thing this cannot see: a spec that routes its own socket. The relay a
 * route handler opens is a real socket and is what these listeners observe, so
 * a reply the handler withheld from the page is still recorded as delivered.
 * The connection probe detects the routing and the verdict says so outright,
 * rather than vouching for a page that never received the frame.
 *
 * Attaching is idempotent per page. Attach BEFORE the navigation wherever the
 * caller owns it: Playwright reports frames only for sockets opened after the
 * listener exists, so a late attach sees nothing whatsoever rather than a
 * partial history. `sockets` and `sawHandshake` are what separate that case
 * from a page which genuinely never subscribed, and every "never" this record
 * reports is qualified by them.
 */
export function watchWire(page) {
	const existing = wireRecords.get(page);
	if (existing) return existing;
	const record = createWireRecord();
	wireRecords.set(page, record);
	const t0 = Date.now();
	const since = () => Date.now() - t0;

	page.on('websocket', (ws) => {
		if (!isAppWebSocket(ws)) return;
		record.sockets++;
		ws.on('framesent', (frame) => applyWireFrame(record, 'out', parseWireFrame(frame.payload), since()));
		ws.on('framereceived', (frame) => applyWireFrame(record, 'in', parseWireFrame(frame.payload), since()));
	});
	return record;
}

/**
 * Wait for content that can only exist once a subscription delivered, and name
 * the subscription when it does not arrive.
 *
 * This is the gate for the failure that clears the connection wait and then
 * times out on the first thing the page renders from live data. Passing a
 * `stream` is what makes the verdict discriminating: without one the report can
 * only say that SOME subscription succeeded, which a page waiting on a
 * different stream is entitled to have happen while it still shows nothing.
 */
export async function waitForData(page, locator, { what, stream, timeout = 15000 } = {}) {
	const record = watchWire(page);
	try {
		await locator.waitFor({ state: 'visible', timeout });
	} catch (error) {
		error.message = `${error.message}\n\n--- stream probe: ${what ?? 'content'} ---\n${formatWire(record, { stream })}`;
		// Carried structurally as well as in the message: a spec asserting on
		// the verdict should not have to parse prose to reach it.
		error.wire = record;
		throw error;
	}
	return record;
}

/**
 * Wait for the application WebSocket. Register `onOpen` synchronously with
 * Playwright's websocket event so initial subscribe frames cannot race past
 * the test before it attaches frame listeners.
 */
export function waitForAppWebSocket(page, { timeout = 15000, onOpen } = {}) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			page.off('websocket', handleWebSocket);
			reject(new Error(`Application WebSocket did not appear within ${timeout}ms`));
		}, timeout);

		function handleWebSocket(ws) {
			if (!isAppWebSocket(ws)) return;
			clearTimeout(timer);
			page.off('websocket', handleWebSocket);
			try {
				onOpen?.(ws);
				resolve(ws);
			} catch (error) {
				reject(error);
			}
		}

		page.on('websocket', handleWebSocket);
	});
}

/**
 * Create a fresh board and return its URL path.
 * Waits for WS connection before submitting to prevent RPC failures.
 */
export async function createBoard(page, name) {
	await page.goto('/');
	await waitForWS(page);
	await page.getByPlaceholder('New board name...').fill(name || `Test ${Date.now()}`);
	await page.getByRole('button', { name: 'Create' }).click();
	await page.waitForURL(/\/board\//, { timeout: 15000 });
	return new URL(page.url()).pathname;
}

/**
 * Get the canvas locator on a board page.
 */
export function getCanvas(page) {
	return page.locator('div.relative.w-full.overflow-auto');
}

/**
 * Double-click on the canvas at a given offset to create a note.
 * Uses absolute page coordinates offset from canvas top-left.
 */
export async function createNote(page, offsetX = 300, offsetY = 300) {
	const canvas = getCanvas(page);
	const box = await canvas.boundingBox();
	await page.mouse.dblclick(box.x + offsetX, box.y + offsetY);
	await page.waitForTimeout(2000);
}

/**
 * Get all sticky note locators (the absolute-positioned cards).
 */
export function getNotes(page) {
	return page.locator('.absolute.w-52');
}

/**
 * Wait for the board to be fully loaded (spinner gone, board header visible).
 */
export async function waitForBoardReady(page) {
	// A gate that can fail. The previous version could not: both of its waits
	// ended in `.catch(() => {})`, so a timeout was swallowed and it returned as
	// though it had succeeded; the element it waited on was the `h1`, which is
	// server-rendered and therefore says nothing about whether the client ever
	// booted; and what remained was an unconditional 500ms sleep. A page whose
	// bundle never ran passed through in half a second, and the failure surfaced
	// thirty seconds later on whatever locator the test happened to touch first.
	//
	// The connection wait is the part that proves a live client, and it carries
	// the probe diagnostics, so a dead bundle is named here rather than inferred
	// from a canvas that never appeared.
	await waitForWS(page);
	// Best-effort by design: the spinner is transient and a fast board may never
	// show one, so its absence is not a failure. It stays because when it IS
	// present, leaving early would race the render.
	await page.locator('.loading').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
	// The canvas is client-rendered, which is what makes this the assertion the
	// old `h1` wait only looked like. Not swallowed: if the board never paints,
	// that is the failure, reported here at the gate. The page holds its spinner
	// until the notes stream returns, so a canvas that never appears is a
	// statement about that one stream, and the report names it rather than
	// leaving the reader with a selector that did not match.
	await waitForData(page, getCanvas(page), { what: 'board canvas', stream: 'boards/notes/notes' });
}

/**
 * Open a coarse-pointer (touch) page for target-size assertions. The
 * pointer-coarse: styles only apply on a genuinely coarse rung, so the
 * helper asserts `(pointer: coarse)` matches before handing the page
 * back - without that gate a fine-pointer context measures the compact
 * desktop sizes and the assertion is vacuous in whichever direction.
 * Caller closes the returned context.
 */
export async function openTouchPage(browser, { width = 390, height = 844 } = {}) {
const context = await browser.newContext({
		viewport: { width, height },
		hasTouch: true,
		isMobile: true
	});
	const page = await context.newPage();
	await page.goto('about:blank');
	expect(
		await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
		'touch emulation must present a coarse pointer or every touch-target assertion is vacuous'
	).toBe(true);
	return { context, page };
}

/**
 * Assert a control's rendered box meets the platform touch floor.
 * 44px per Apple HIG / WCAG 2.5.8 AAA; pass minWidth: 0 for full-width
 * controls where only height is the constrained axis.
 */
export async function expectTouchTarget(locator, { minWidth = 44, minHeight = 44 } = {}) {
const box = await locator.boundingBox();
	expect(box, 'control must be visible to measure').not.toBeNull();
	if (minHeight > 0) expect(box.height, 'touch-target height').toBeGreaterThanOrEqual(minHeight);
	if (minWidth > 0) expect(box.width, 'touch-target width').toBeGreaterThanOrEqual(minWidth);
}
