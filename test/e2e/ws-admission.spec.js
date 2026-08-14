/**
 * Handshake admission: which WebSocket upgrades the server agrees to.
 *
 * Every case here is driven from a node client rather than a page, because
 * the header under test is one a browser will not let script set. `Origin`
 * on a handshake is stamped by the browser itself, so the only way to ask
 * "what happens when it is wrong" is to be the client.
 *
 * The accepted case is asserted alongside the refused ones on purpose. A
 * suite that only asserts refusals passes just as well against a server that
 * refuses everything, including a server that is simply down, so the refusal
 * assertions on their own cannot tell a working policy from a broken one.
 *
 * These expect the target to have a canonical origin configured, which the
 * local tier runner does when it starts each instance. Pointed at a bare
 * `npm run dev` with no ORIGIN, the Origin-less case is admitted by design
 * and this file reports that difference rather than hiding it.
 */

import http from 'node:http';
import https from 'node:https';
import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import { resolveE2EBaseURL, toWebSocketURL, toHandshakeOrigin } from '../../scripts/test-target.mjs';

const BASE_URL = resolveE2EBaseURL();
const WS_URL = toWebSocketURL(BASE_URL);
const WS_ORIGIN = toHandshakeOrigin(WS_URL);

/**
 * GET `/` with an arbitrary Host header.
 *
 * Driven through `node:http` rather than Playwright's request context
 * because `Host` is one of the headers a client library is entitled to
 * own, and setting it is the whole point of the test.
 *
 * @param {string} hostHeader
 * @returns {Promise<number>}
 */
function statusForHost(hostHeader) {
	const target = new URL(BASE_URL);
	const transport = target.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const request = transport.request({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || (target.protocol === 'https:' ? 443 : 80),
			path: '/',
			method: 'GET',
			headers: { host: hostHeader },
			rejectUnauthorized: false
		}, (response) => {
			response.resume();
			resolve(response.statusCode);
		});
		request.setTimeout(15_000, () => {
			request.destroy();
			reject(new Error(`no answer from ${BASE_URL} within 15s`));
		});
		request.on('error', reject);
		request.end();
	});
}

/**
 * Attempt one handshake and report how the server answered.
 *
 * Resolves to the HTTP status of a refusal, or 101 when the socket opened.
 * Settling is guarded because `ws` emits `error` after `unexpected-response`
 * for the same failure, and the first answer is the informative one.
 *
 * @param {{ origin?: string }} options
 * @returns {Promise<number>}
 */
function handshakeStatus({ origin }) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(WS_URL, {
			...(origin ? { origin } : {}),
			rejectUnauthorized: false
		});
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			socket.terminate();
			reject(new Error(`handshake to ${WS_URL} produced no answer within 15s`));
		}, 15_000);
		timer.unref?.();

		socket.on('open', () => {
			socket.close();
			clearTimeout(timer);
			settle(101);
		});
		socket.on('unexpected-response', (_request, response) => {
			clearTimeout(timer);
			response.resume();
			settle(response.statusCode);
		});
		socket.on('error', () => {
			clearTimeout(timer);
			settle(0);
		});
	});
}

test('a handshake carrying the deployment origin is accepted', async () => {
	expect(await handshakeStatus({ origin: WS_ORIGIN })).toBe(101);
});

test('a handshake carrying a foreign origin is refused', async () => {
	expect(await handshakeStatus({ origin: 'https://not-this-deployment.example' })).toBe(403);
});

test('a handshake with no origin at all is refused', async () => {
	// 401 rather than 403: the refusal comes from the application upgrade
	// hook, and the adapter answers a hook rejection with 401. A 403 here
	// would mean the adapter refused it first, which it does not do for a
	// request with no Origin while an upgrade hook is exported.
	expect(await handshakeStatus({})).toBe(401);
});

test('refused upgrades are counted where a scraper can see them', async ({ request }) => {
	const token = process.env.METRICS_SCRAPE_TOKEN;
	test.skip(!token, 'scraping /metrics needs the deployment METRICS_SCRAPE_TOKEN');

	// Only the hook's own refusal is asserted. The adapter counts the
	// refusals it makes before the hook on a registry of its own, which a
	// scrape of this endpoint cannot reach; asserting it here would be
	// asserting a number this process never publishes.
	expect(await handshakeStatus({})).toBe(401);

	const response = await request.get('/metrics', { headers: { 'x-scrape-token': token } });
	expect(response.status()).toBe(200);
	const body = await response.text();

	expect(body).toMatch(/^ws_upgrade_refused_total\{[^}]*reason="originless_refused"[^}]*\}\s+[1-9]/m);
});

test('a request naming a foreign Host is refused, and loopback still serves', async () => {
	// The loopback case first: it is the one that would take the whole site
	// down if the check were wrong, and it is how every health probe and this
	// suite address the server.
	expect(await statusForHost(new URL(BASE_URL).host)).toBe(200);
	expect(await statusForHost('not-this-deployment.example')).toBe(400);
});

test('responses forbid embedding the pages under another origin', async ({ request }) => {
	const response = await request.get('/');
	expect(response.status()).toBe(200);
	expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
});
