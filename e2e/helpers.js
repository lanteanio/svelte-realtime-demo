/**
 * Shared helpers for E2E tests
 */

/**
 * Wait for the WebSocket to be connected (green wifi icon visible).
 */
export async function waitForWS(page) {
	await page.locator('.text-success').first().waitFor({ state: 'visible', timeout: 15000 });
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
