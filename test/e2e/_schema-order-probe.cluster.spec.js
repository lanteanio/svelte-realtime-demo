/**
 * Does a cross-replica publish carry anything a client could order by?
 *
 * Four cluster tests fail as coordination assertions, and schema-evolution is
 * the cleanest statement of the suspected mechanism: two replicas each
 * increment the same Redis key, HINCRBY is atomic so the key genuinely reaches
 * 2, and yet a client can settle permanently on 1.
 *
 * The reading under test is that each replica publishes the value IT observed
 * as an ABSOLUTE row - replica A publishes 1, replica B publishes 2 - and the
 * stream merges `crud` by key, which is replace-by-arrival. A client that
 * happens to receive 2 and then 1 shows 1 forever, because those two clicks are
 * the only publishes there will ever be. A transient wrong value would heal; a
 * stale terminal one cannot.
 *
 * That has been inferred from reading the demo and the merge strategy. It has
 * never been observed on the wire, and the two candidate explanations are not
 * distinguishable from a screenshot:
 *
 *   - both values arrive, in the wrong order, with no ordering metadata
 *     -> the publish contract is racy for every absolute-value topic, and the
 *        fix belongs there rather than in four separate demos;
 *   - only the stale value ever arrives
 *     -> a relay/delivery problem, an entirely different fault with a
 *        different owner.
 *
 * So this captures the frames rather than the outcome. Assertion-free by
 * design: it measures, it does not gate, and it stays off unless asked for
 * because the cluster project matches every *.cluster.spec.js.
 *
 *   SCHEMA_ORDER_PROBE=1 node scripts/run-local-e2e.mjs cluster _schema-order-probe
 */

import { test } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { confirmAndClick, isAppWebSocket, waitForWS } from './helpers.js'

const INSTANCE_A = assertSafeE2ETarget(process.env.BASE_URL || 'http://localhost:3091').href.replace(/\/$/, '')
const INSTANCE_B = assertSafeE2ETarget(process.env.INSTANCE_B || 'http://localhost:3092').href.replace(/\/$/, '')

test.skip(!process.env.INSTANCE_B, 'schema order probe requires two explicit replica targets')
test.skip(!process.env.SCHEMA_ORDER_PROBE, 'diagnostic probe; set SCHEMA_ORDER_PROBE=1 to run')
test.describe.configure({ mode: 'serial' })

/**
 * Record every frame the page's application socket receives, with arrival
 * times, so the ORDER is recoverable and not just the set.
 */
function captureFrames(page, label) {
	const frames = [];
	const t0 = Date.now();
	page.on('websocket', (ws) => {
		if (!isAppWebSocket(ws)) return;
		ws.on('framereceived', (frame) => {
			// Binary frames have no payload string worth parsing here; record
			// that one arrived so a gap in the text record is not mistaken for
			// silence on the wire.
			const payload = typeof frame.payload === 'string' ? frame.payload : `<binary ${frame.payload?.length ?? 0}B>`;
			frames.push({ at: Date.now() - t0, label, payload });
		});
	});
	return frames;
}

/** Pull out only the frames that mention this demo's counter topic. */
function counterFrames(frames) {
	return frames.filter((f) => f.payload.includes('demos:schema-evolution:counter'));
}

test.describe('cluster probe: schema-evolution publish ordering', () => {
	test('capture both replicas publishing the same key concurrently', async ({ browser }) => {
		const ctxA = await browser.newContext({ baseURL: INSTANCE_A });
		const ctxB = await browser.newContext({ baseURL: INSTANCE_B });
		const a = await ctxA.newPage();
		const b = await ctxB.newPage();
		try {
			const framesA = captureFrames(a, 'A');
			const framesB = captureFrames(b, 'B');

			await a.goto(`${INSTANCE_A}/demos/schema-evolution`);
			await b.goto(`${INSTANCE_B}/demos/schema-evolution`);
			await waitForWS(a);
			await waitForWS(b);

			await confirmAndClick(a.getByTestId('reset'));
			// Let the reset publishes land on both sides before the subject, so
			// the frames below cannot be confused with reset traffic.
			await a.waitForTimeout(1_500);
			const beforeA = counterFrames(framesA).length;
			const beforeB = counterFrames(framesB).length;

			await Promise.all([
				a.getByTestId('bump-alpha').click(),
				b.getByTestId('bump-alpha').click()
			]);
			await a.waitForTimeout(3_000);

			const newA = counterFrames(framesA).slice(beforeA);
			const newB = counterFrames(framesB).slice(beforeB);
			const displayedA = await a.getByTestId('v2-value-alpha').textContent();
			const displayedB = await b.getByTestId('v2-value-alpha').textContent();

			console.log('\n=== schema-evolution cross-replica publish order ===');
			console.log(`displayed after both increments: A=${displayedA} B=${displayedB} (expected 2 and 2)`);
			for (const [side, frames] of [['A', newA], ['B', newB]]) {
				console.log(`\n--- client ${side}: ${frames.length} counter frame(s) ---`);
				for (const f of frames) console.log(`  ${f.at}ms ${f.payload}`);
			}
			console.log(`
Read it like this. Two frames carrying different values, arriving newest-loses,
means the publish contract has no ordering and the fix is there. One frame
carrying the stale value means the other replica's publish never arrived at
all, which is a relay fault instead. Look for any seq / version / timestamp
field that a client COULD have ordered by before concluding the contract has
nothing to offer.`);
		} finally {
			await Promise.allSettled([ctxA.close(), ctxB.close()]);
		}
	});
});
