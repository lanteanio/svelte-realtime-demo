import { test, expect } from '@playwright/test';
import { waitForWS } from './helpers.js';

test('WebSocket lifecycle: document navigation closes replaced connections', async ({ page, request, baseURL }, testInfo) => {
	// The counter covers this server, so this test requires the runner's
	// exclusive local services and the serial isolated project.
	expect(testInfo.project.name).toBe('isolated');
	expect(process.env.LOCAL_E2E).toBe('1');
	const token = process.env.METRICS_SCRAPE_TOKEN;
	expect(typeof token === 'string' && token.length > 0).toBe(true);

	async function closedConnections() {
		const response = await request.get(new URL('/metrics', baseURL).href, {
			headers: { 'X-Scrape-Token': token }
		});
		expect(response.ok()).toBe(true);
		const text = await response.text();
		return [...text.matchAll(/^ws_connection_close_total(?:\{[^}]*\})?\s+([\d.eE+-]+)\s*$/gm)]
			.reduce((total, match) => total + Number(match[1]), 0);
	}

	// Let teardown from the previous serial test finish before taking the
	// baseline. Three unchanged scrapes also avoid counting its late closes.
	let baseline = await closedConnections();
	let unchanged = 0;
	await expect.poll(async () => {
		const count = await closedConnections();
		unchanged = count === baseline ? unchanged + 1 : 0;
		baseline = count;
		return unchanged;
	}, { intervals: [100, 100, 100] }).toBe(3);

	let created = 0;
	page.on('websocket', () => { created++; });
	let expectedCreated = 0;
	async function navigate(action) {
		expectedCreated++;
		await action();
		await waitForWS(page);
		await expect.poll(() => created).toBe(expectedCreated);
		await expect.poll(closedConnections, {
			message: 'the server must close every replaced document connection'
		}).toBe(baseline + expectedCreated - 1);
	}

	await navigate(() => page.goto('/'));
	await navigate(() => page.goto('/demos/chat'));
	await navigate(() => page.goto('/'));
	await navigate(() => page.reload());
	await page.close();
	await expect.poll(closedConnections, {
		message: 'closing the final page must close every connection created by this test'
	}).toBe(baseline + expectedCreated);
	expect(created).toBe(expectedCreated);
});
