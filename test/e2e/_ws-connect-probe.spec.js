/**
 * Diagnostic probe for the waitForWS false-failure rate.
 *
 * The merge gate fails roughly one page-open per full run with a 15s
 * waitForWS timeout, and a full run costs ~350 tests to maybe reproduce it
 * once. This probe collapses that: it opens a page repeatedly against the same
 * server and reports the distribution of time-to-connected plus every socket
 * attempt that did not reach open.
 *
 * The question it answers is which side stalls. The client's reconnect backoff
 * is base 3000ms with a 2.2 exponent and [0.75, 1.25] jitter
 * (svelte-adapter-uws/src/client.js:772, client-runtime.js:119), so a page open
 * that loses N connect attempts cannot show green before:
 *
 *   1 loss -> 2.25 to 3.75s      2 losses -> 7.95 to 11.25s
 *   3 losses -> 20.49 to 27.75s  4 losses -> 48.08 to 64.05s
 *
 * A 15s budget therefore sits in a dead zone: it survives two lost attempts and
 * can never survive three, even though the client would have connected fine at
 * ~24s. If this probe shows lost attempts, the gate is timing out on backoff
 * rather than on a broken server, and the fix belongs at the retry schedule
 * rather than at the timeout constant. If it shows zero lost attempts across
 * many opens, the stall is elsewhere and this is the wrong tree.
 *
 * Assertion-free by design: it measures, it does not gate. It lives in the
 * diagnostics tier (_*.spec.js), which main ignores.
 */

import { test } from '@playwright/test';
import { waitForWS, WS_CONNECT_TIMEOUT, WS_SLOW_CONNECT } from './helpers.js';

const OPENS = Number(process.env.WS_PROBE_OPENS ?? 60);

// Cycle the whole demo surface rather than reopening one route. Two full main
// tiers showed zero connects even reaching 2s, so whatever stalls is not a
// property of the connect itself. Route CHURN is the axis that matters: 900
// cycling opens reproduced the stall twice, while 80 opens of a single route
// reproduced it zero times, and the difference between those is whether the
// dev server keeps being asked for a module graph it has not just served.
// Ordered so the two historical victims, checkout and effect, come first.
//
// WS_PROBE_ROUTE takes a BARE demo name, never a path. A value starting with
// '/' is rewritten to a Windows path by Git Bash's MSYS path conversion before
// node ever sees it, which silently turns a focused sweep into 80 failed
// navigations that report as 80 findings.
const ROUTES = (process.env.WS_PROBE_ROUTE ? [`/demos/${process.env.WS_PROBE_ROUTE.replace(/^.*[/\\]/, '')}`] : [
	'/demos/checkout', '/demos/effect', '/demos/alarms', '/demos/arena', '/demos/auctions',
	'/demos/chaos', '/demos/chat', '/demos/cluster-cron', '/demos/collab-editor',
	'/demos/counter-resume', '/demos/denials', '/demos/flags', '/demos/flash-sales',
	'/demos/forget', '/demos/from-seq', '/demos/jobs', '/demos/kanban', '/demos/lobbies',
	'/demos/multiplayer', '/demos/news', '/demos/notifications', '/demos/offline',
	'/demos/ops', '/demos/outbound-webhooks', '/demos/pagination', '/demos/phases',
	'/demos/pressure', '/demos/privacy', '/demos/schema-evolution', '/demos/shooter',
	'/demos/tenants', '/demos/todos-rollback', '/demos/topk', '/demos/upload'
]);

test.describe('ws connect probe', () => {
	// Budget per open has to cover a heavy route (shooter, arena) plus the full
	// connect wait, or a long sweep dies on its own timeout rather than on a
	// finding. Floor at 15 minutes so a small sweep is not starved either.
	test.describe.configure({ timeout: Math.max(15 * 60 * 1000, OPENS * 8000) });

	test('measure time-to-connected across repeated page opens', async ({ browser }) => {
		const samples = [];
		const incidents = [];

		for (let i = 0; i < OPENS; i++) {
			// A fresh context per open is what the suite does between specs, so
			// the socket churn matches the conditions the gate actually runs in.
			const route = ROUTES[i % ROUTES.length];
			const context = await browser.newContext();
			const page = await context.newPage();
			const started = Date.now();
			let failed = null;
			// Take the snapshot the wait itself returns rather than reading
			// `window.__wsProbe` back out. The live probe carries its `rearm`
			// function, and a function does not survive `page.evaluate`'s
			// serialisation - reading it directly would hand back a probe with
			// pieces missing, or nothing at all.
			let probe = null;
			try {
				await page.goto(route);
				// Deliberately generous: the point is to observe how long the
				// client really takes, not to reproduce the gate's own cutoff.
				probe = await waitForWS(page, 70_000);
			} catch (error) {
				failed = error.message;
				// A failed wait is the whole reason this sweep exists, so take the
				// probe the error carries instead of losing the socket list here.
				probe = error.probe ?? null;
			}
			const elapsed = Date.now() - started;
			const attempts = probe?.sockets ?? [];
			const lost = attempts.filter((s) => s.opened === undefined).length;
			samples.push({ i, route, elapsed, attempts: attempts.length, lost, failed: Boolean(failed) });

			if (lost > 0 || failed || elapsed > WS_SLOW_CONNECT) {
				incidents.push({
					open: i,
					route,
					elapsed,
					failed,
					states: (probe?.states ?? []).map((s) => `${s.at}ms ${s.state}`).join(' -> '),
					sockets: attempts.map((s) => ({
						at: s.at, opened: s.opened, closed: s.closed, code: s.code, reason: s.reason, wasClean: s.wasClean
					}))
				});
			}
			await context.close();
		}

		const elapsedTimes = samples.map((s) => s.elapsed).sort((a, b) => a - b);
		const at = (q) => elapsedTimes[Math.min(elapsedTimes.length - 1, Math.floor(elapsedTimes.length * q))];
		const lostTotal = samples.reduce((sum, s) => sum + s.lost, 0);
		const overBudget = samples.filter((s) => s.elapsed > WS_CONNECT_TIMEOUT).length;

		// Worst case per route, so a single bad route cannot hide inside an
		// aggregate percentile computed across all of them.
		const worstByRoute = new Map();
		for (const s of samples) {
			if ((worstByRoute.get(s.route) ?? -1) < s.elapsed) worstByRoute.set(s.route, s.elapsed);
		}
		const worstRoutes = [...worstByRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

		console.log(`\n=== ws connect probe: ${OPENS} opens across ${ROUTES.length} routes ===`);
		console.log(`time-to-connected ms  min=${elapsedTimes[0]} p50=${at(0.5)} p90=${at(0.9)} p99=${at(0.99)} max=${elapsedTimes[elapsedTimes.length - 1]}`);
		console.log(`lost socket attempts: ${lostTotal} across ${OPENS} opens`);
		console.log(`opens over the ${WS_CONNECT_TIMEOUT}ms gate budget: ${overBudget}`);
		console.log(`opens over the ${WS_SLOW_CONNECT}ms near-miss threshold: ${samples.filter((s) => s.elapsed > WS_SLOW_CONNECT).length}`);
		console.log(`hard failures: ${samples.filter((s) => s.failed).length}`);
		console.log(`slowest route worst-cases: ${worstRoutes.map(([r, ms]) => `${r}=${ms}ms`).join(' ')}`);
		if (incidents.length) console.log(`\nincidents:\n${JSON.stringify(incidents, null, 2)}`);
		else console.log('\nno incidents: every open connected on its first socket attempt');
	});
});
