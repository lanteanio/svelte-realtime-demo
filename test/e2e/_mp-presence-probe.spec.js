/**
 * Diagnostic probe for the multiplayer presence-roster failure.
 *
 * The failure is that two visitors in one live.multiplayer room do not see
 * each other: each renders its own `(you)` entry and `mp-roster-other` stays
 * empty. It has only ever been caught inside a full 353-test tier, which is a
 * 17 minute round trip for one observation, and it did not reproduce in three
 * runs of the identical 161-test tier prefix. That is a poor instrument for
 * something that is probably an ordinary intermittent fault.
 *
 * This does the same thing the two-visitor tests do and nothing else, in a
 * loop: pair two fresh contexts in the room, wait for each to see the other,
 * record what happened. At a few seconds per pairing that is two orders of
 * magnitude more observations per minute than the tier gives, which is what
 * turns a rate estimate into something with error bars rather than a
 * two-sample impression.
 *
 * On a failure it captures the state that distinguishes the candidate causes,
 * because "the roster was empty" alone cannot tell them apart:
 *
 *   both sides empty        -> neither join was published, or the room dropped both
 *   one side empty          -> asymmetric delivery, so the join reached the server
 *   own entry also missing  -> not presence at all; the page never got its own join
 *   peer present but late   -> a latency problem wearing a correctness costume
 *
 * Assertion-free by design: it measures and reports, it does not gate. Lives
 * in the diagnostics tier (_*.spec.js), which main ignores.
 */

import { test } from '@playwright/test';
import { waitForWS } from './helpers.js';
import { readRoster } from './multiplayer-helpers.js';

const PAIRS = Number(process.env.MP_PROBE_PAIRS ?? 40);
const PEER_TIMEOUT = Number(process.env.MP_PROBE_PEER_TIMEOUT ?? 15_000);

test.describe('multiplayer presence probe', () => {
	test.describe.configure({ timeout: Math.max(15 * 60 * 1000, PAIRS * 30_000) });

	test('measure the two-visitor presence convergence rate', async ({ browser }) => {
		const results = [];
		const incidents = [];

		for (let i = 0; i < PAIRS; i++) {
			const ctxA = await browser.newContext();
			const ctxB = await browser.newContext();
			const a = await ctxA.newPage();
			const b = await ctxB.newPage();
			const started = Date.now();
			let converged = false;
			let error = null;
			try {
				// Both visitors land before either waits for the other, so the
				// probe measures convergence rather than a staggered arrival.
				await Promise.all([a.goto('/demos/multiplayer'), b.goto('/demos/multiplayer')]);
				await Promise.all([waitForWS(a), waitForWS(b)]);
				const deadline = Date.now() + PEER_TIMEOUT;
				for (;;) {
					const [ra, rb] = await Promise.all([readRoster(a), readRoster(b)]);
					if (ra.self && rb.self
						&& ra.others.some((o) => o.includes(rb.self))
						&& rb.others.some((o) => o.includes(ra.self))) { converged = true; break; }
					if (Date.now() > deadline) break;
					await a.waitForTimeout(250);
				}
			} catch (err) {
				error = err.message;
			}
			const elapsed = Date.now() - started;
			results.push({ i, converged, elapsed, error: Boolean(error) });

			if (!converged) {
				const [ra, rb] = await Promise.all([readRoster(a), readRoster(b)]);
				incidents.push({ pair: i, elapsed, error, a: ra, b: rb });
			}
			await Promise.all([ctxA.close(), ctxB.close()]);
		}

		const failures = results.filter((r) => !r.converged);
		const times = results.filter((r) => r.converged).map((r) => r.elapsed).sort((x, y) => x - y);
		const at = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : -1);
		// Wilson score interval: a plain proportion is misleading at these
		// sample sizes, and the whole point of this probe is an honest rate.
		const n = results.length;
		const p = failures.length / n;
		const z = 1.96;
		const denom = 1 + (z * z) / n;
		const centre = (p + (z * z) / (2 * n)) / denom;
		const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;

		console.log(`\n=== multiplayer presence probe: ${n} pairings ===`);
		console.log(`failures: ${failures.length}/${n} (${(p * 100).toFixed(1)}%)`);
		console.log(`95% CI (Wilson): ${(Math.max(0, centre - half) * 100).toFixed(1)}% to ${(Math.min(1, centre + half) * 100).toFixed(1)}%`);
		console.log(`convergence ms among successes: p50=${at(0.5)} p90=${at(0.9)} max=${times[times.length - 1] ?? -1}`);
		if (incidents.length) console.log(`\nincidents:\n${JSON.stringify(incidents.slice(0, 10), null, 2)}`);
		else console.log('\nno incidents: every pairing converged');
	});
});
