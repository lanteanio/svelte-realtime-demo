/**
 * Shared helpers for E2E tests
 */

import { expect } from '@playwright/test';

/** How long a page gets to show a connected socket before the wait fails. */
export const WS_CONNECT_TIMEOUT = 15000;

/** Above this, a connect is logged as a near miss even though it passed. */
export const WS_SLOW_CONNECT = 2000;

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
	if (window.__wsProbe) return;
	const probe = { t0: performance.now(), states: [], sockets: [] };
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
	sample();
	probe.timer = setInterval(sample, 100);

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

/** Render the probe's findings for a failure message. */
function formatConnectionProbe(probe) {
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
	return `status timeline: ${states}\nsocket attempts:\n${sockets}`;
}

/**
 * Wait for the WebSocket to be connected (green wifi icon visible).
 *
 * A timeout here means the client genuinely held a non-open socket for the
 * whole budget, since the navbar only paints `.text-success` for the 'open'
 * and 'suspended' states. That makes the wait an honest signal but a useless
 * report, so a failure is enriched with the connection probe above.
 */
export async function waitForWS(page, timeout = WS_CONNECT_TIMEOUT) {
	await page.evaluate(installConnectionProbe).catch(() => { /* pre-hydration; the wait still stands on its own */ });
	const started = Date.now();
	let failure = null;
	try {
		await page.locator('.text-success').first().waitFor({ state: 'visible', timeout });
	} catch (error) {
		failure = error;
	}
	const elapsed = Date.now() - started;
	const probe = await page.evaluate(() => {
		const found = window.__wsProbe ?? null;
		if (found?.timer) clearInterval(found.timer);
		return found;
	}).catch(() => null);

	if (failure) {
		failure.message = `${failure.message}\n\n--- connection probe (${elapsed}ms) ---\n${formatConnectionProbe(probe)}`;
		throw failure;
	}
	// Report the slow tail, not just the outright failures. A measured 60-open
	// sample put this connect at p99 425ms against a 15000ms budget, so the
	// budget is not the thing under strain and a plain pass/fail gate throws
	// away every near miss. Anything past this threshold is a multiple of the
	// whole observed distribution and is worth a line in the run log, so one
	// clean run still produces evidence instead of only a coin flip on whether
	// the rare hard failure happened to fire.
	if (elapsed > WS_SLOW_CONNECT) {
		console.log(`[ws-slow] ${page.url()} connected after ${elapsed}ms\n${formatConnectionProbe(probe)}`);
	}
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

/** True only for the application's realtime socket, never Vite's HMR socket. */
export function isAppWebSocket(ws) {
	try {
		return new URL(ws.url()).pathname === '/ws';
	} catch {
		return false;
	}
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
	await page.locator('.loading').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
	await page.locator('h1').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(500);
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
