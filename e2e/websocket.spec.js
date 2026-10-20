import { test, expect } from '@playwright/test';
import { createBoard, waitForWS } from './helpers.js';

async function observeNativeSockets(page) {
	await page.addInitScript(() => {
		const NativeWebSocket = window.WebSocket;
		const sockets = [];
		window.__webSocketAudit = { documentId: crypto.randomUUID(), sockets };
		window.WebSocket = class extends NativeWebSocket {
			constructor(...args) {
				super(...args);
				sockets.push(this);
			}
		};
	});
}

async function socketState(page) {
	return page.evaluate(() => ({
		documentId: window.__webSocketAudit.documentId,
		open: window.__webSocketAudit.sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
		connecting: window.__webSocketAudit.sockets.filter((socket) => socket.readyState === WebSocket.CONNECTING).length
	}));
}

async function expectOneNativeSocket(page) {
	await expect.poll(async () => {
		const { open, connecting } = await socketState(page);
		return { open, connecting };
	}, { message: 'the current document must have exactly one live WebSocket' }).toEqual({ open: 1, connecting: 0 });
	return socketState(page);
}

async function createBoardThroughForm(page, name) {
	await page.getByPlaceholder('New board name...').fill(name);
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(page).toHaveURL(/\/board\//);
	await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Set background to #f5f5f4', exact: true })).toBeVisible();
}

async function returnHomeThroughLink(page) {
	await page.locator('.navbar a[href="/"]').click();
	await expect(page.getByRole('heading', { level: 1, name: 'Boards', exact: true })).toBeVisible();
	await expect(page.getByPlaceholder('New board name...')).toBeVisible();
}

test.describe('WebSocket Connection', () => {
	test('WebSocket connects on page load', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;
		expect(ws.url()).toContain('/ws');
	});

	test('WebSocket protocol matches page protocol (wss for https, ws for http)', async ({ page, baseURL }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;
		// Production / staging serves over https -> wss. Local dev / e2e
		// against `http://localhost:NNNN` serves over http -> ws. The
		// scheme must match the page scheme, never downgrade.
		const expectedProtocol = new URL(baseURL ?? page.url()).protocol === 'https:' ? 'wss:' : 'ws:';
		expect(ws.url()).toMatch(new RegExp('^' + expectedProtocol + '//'));
	});

	test('WebSocket exchanges frames after connection', async ({ page }) => {
		const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
		await page.goto('/');
		const ws = await wsPromise;

		const sent = ws.waitForEvent('framesent', { timeout: 5000 });
		await sent;

		const received = ws.waitForEvent('framereceived', { timeout: 5000 });
		await received;
	});

	test('connection status shows green wifi icon when connected', async ({ page }) => {
		await page.goto('/');
		await page.waitForTimeout(2000);
		const wifiIcon = page.locator('.text-success').first();
		await expect(wifiIcon).toBeVisible();
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
		await page.goto('/');
		await page.waitForEvent('websocket', { timeout: 10000 });

		const boardUrl = await createBoard(page, `WS Nav ${Date.now()}`);

		await page.waitForTimeout(1000);
		const wifiIcon = page.locator('.text-success');
		await expect(wifiIcon.first()).toBeVisible({ timeout: 5000 });
	});

	test('one WebSocket per document through navigation and refresh', async ({ page }) => {
		await observeNativeSockets(page);
		await page.goto('/');
		await waitForWS(page);
		const initial = await expectOneNativeSocket(page);

		// Use hydrated application navigation so this checks one document's
		// singleton through page changes, including actual form submission.
		await createBoardThroughForm(page, `WS Audit ${Date.now()}`);
		expect((await expectOneNativeSocket(page)).documentId).toBe(initial.documentId);
		await returnHomeThroughLink(page);
		expect((await expectOneNativeSocket(page)).documentId).toBe(initial.documentId);

		// Document replacement has its own observer. Browser automation can
		// omit old-document close events; inspect real current socket states.
		await page.goto('/');
		await waitForWS(page);
		const afterNavigation = await expectOneNativeSocket(page);
		expect(afterNavigation.documentId).not.toBe(initial.documentId);
		await page.reload();
		await waitForWS(page);
		expect((await expectOneNativeSocket(page)).documentId).not.toBe(afterNavigation.documentId);
	});

	test('navigating between multiple boards does not leak connections', async ({ page }) => {
		await observeNativeSockets(page);
		await page.goto('/');
		await waitForWS(page);
		const initial = await expectOneNativeSocket(page);

		for (let i = 0; i < 3; i++) {
			await createBoardThroughForm(page, `Leak Test ${i} ${Date.now()}`);
			expect((await expectOneNativeSocket(page)).documentId).toBe(initial.documentId);
			await returnHomeThroughLink(page);
			expect((await expectOneNativeSocket(page)).documentId).toBe(initial.documentId);
		}
	});

	test('socket observer detects an additional real WebSocket', async ({ page }) => {
		await observeNativeSockets(page);
		await page.goto('/');
		await waitForWS(page);
		const initial = await expectOneNativeSocket(page);
		try {
			await page.evaluate(async () => {
				const audit = window.__webSocketAudit;
				const existing = audit.sockets.find((socket) => socket.readyState === WebSocket.OPEN);
				const extra = new WebSocket(existing.url);
				audit.control = extra;
				await new Promise((resolve, reject) => {
					extra.addEventListener('open', resolve, { once: true });
					extra.addEventListener('error', () => reject(new Error('additional WebSocket failed to open')), { once: true });
				});
			});
			await expect.poll(() => socketState(page)).toEqual({
				documentId: initial.documentId, open: 2, connecting: 0
			});
		} finally {
			await page.evaluate(async () => {
				const extra = window.__webSocketAudit.control;
				if (!extra || extra.readyState === WebSocket.CLOSED) return;
				await new Promise((resolve) => {
					extra.addEventListener('close', resolve, { once: true });
					extra.close();
				});
			});
		}
		expect((await expectOneNativeSocket(page)).documentId).toBe(initial.documentId);
	});
});
