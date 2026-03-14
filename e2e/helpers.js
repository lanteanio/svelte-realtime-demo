/**
 * Shared helpers for E2E tests
 */

/**
 * Create a fresh board and return its URL path.
 */
export async function createBoard(page, name) {
	await page.goto('/');
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
	// Wait for the loading spinner to disappear
	await page.locator('.loading').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
	// Wait for the board header (h1 with title) to appear
	await page.locator('h1').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(500);
}
