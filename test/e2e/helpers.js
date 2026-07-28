/**
 * Shared helpers for E2E tests
 */

/**
 * Wait for the WebSocket to be connected (green wifi icon visible).
 */
export async function waitForWS(page) {
	await page.locator('.text-success').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function answerDestructiveConfirmation(locator, accept, clickOptions) {
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
	const valid = dialog.type() === 'confirm'
		&& message.includes('shared demo state for everyone')
		&& message.includes('cannot be undone');
	if (accept) await dialog.accept();
	else await dialog.dismiss();
	await clickPromise;
	if (clickError) throw clickError;
	if (!valid) throw new Error(`Unexpected destructive confirmation: ${dialog.type()} ${message}`);
	return message;
}

/** Click a destructive control and accept its shared-state confirmation. */
export function confirmAndClick(locator, clickOptions) {
	return answerDestructiveConfirmation(locator, true, clickOptions);
}

/** Click a destructive control and cancel its shared-state confirmation. */
export function dismissConfirmation(locator, clickOptions) {
	return answerDestructiveConfirmation(locator, false, clickOptions);
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
