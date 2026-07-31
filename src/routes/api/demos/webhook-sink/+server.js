/**
 * POST /api/demos/webhook-sink - the receiving end of the
 * /demos/outbound-webhooks delivery pipeline.
 *
 * Plays the "partner API" role for `live.webhooks.outbound`: it reads
 * the raw body plus the `x-webhook-signature` and `idempotency-key`
 * headers, verifies the HMAC-SHA256 signature against the shared
 * secret, and records a receipt in a bounded Redis list the demo page
 * polls. It has no live ctx and publishes nothing - a deliberate
 * demonstration that the receiver of an outbound webhook is just a
 * plain HTTP endpoint.
 *
 * Signature verification follows the documented receiver contract via
 * the sender package's own `verifyWebhookSignature`: the signed
 * material is `<x-webhook-timestamp>.<rawBody>` (timestamped so a
 * captured delivery stops verifying once the freshness window passes),
 * the header carries one or more comma-separated `sha256=<hex>` entries
 * (several during a key rotation), any entry may match, and the compare
 * is constant-time. An invalid signature is still recorded (with
 * `sigValid: false`) rather than rejected, so the page can SHOW the
 * verification result - a real receiver would return 401 and process
 * nothing.
 *
 * Failure mode: when the delivered order carries `data.mode === 'fail'`
 * the sink answers 500, standing in for a receiver outage. The sender
 * then retries with backoff and, once the attempts are exhausted,
 * dead-letters the event - which is exactly what the demo page's DLQ
 * card is there to show. Each failed attempt still logs a receipt, so
 * the retries (same idempotency key, repeated) are visible too.
 *
 * The dev-fallback secret is acceptable here, unlike in webhook
 * receivers that mutate state: this sink only logs receipts, so the
 * worst a forged POST can do is add a `sigValid: false` line to the
 * demo's own list. Deployments override DEMO_OUTBOUND_WEBHOOK_SECRET
 * anyway to make the signature demonstration honest.
 */

import { json } from '@sveltejs/kit'
import { verifyWebhookSignature } from 'svelte-adapter-uws/plugins/webhooks'
import { redis } from '$lib/server/redis'

const RECEIPTS_KEY = 'demos:outbound:receipts'
const RECEIPTS_MAX = 30

const WEBHOOK_SECRET = process.env.DEMO_OUTBOUND_WEBHOOK_SECRET || 'demo-outbound-secret'

export async function POST({ request }) {
	// The signature covers the exact bytes the sender shipped, so hand
	// the verifier the raw buffer and decode for JSON only afterwards.
	const rawBody = await request.arrayBuffer()
	const sigValid = verifyWebhookSignature(Object.fromEntries(request.headers), rawBody, {
		secret: WEBHOOK_SECRET
	})
	const idempotencyKey = request.headers.get('idempotency-key') ?? null

	const body = Buffer.from(rawBody).toString('utf8')
	let payload = null
	try { payload = JSON.parse(body) } catch { /* non-JSON body: receipt records nulls */ }
	const failRequested = payload?.data?.mode === 'fail'

	// Body summary only - the receipt list is page-rendered, so keep it
	// to the fields the demo displays rather than mirroring the payload.
	const receipt = {
		at: Date.now(),
		event: typeof payload?.event === 'string' ? payload.event : null,
		orderId: typeof payload?.data?.id === 'string' ? payload.data.id : null,
		mode: failRequested ? 'fail' : 'ok',
		idempotencyKey,
		sigValid,
		status: failRequested ? 500 : 200
	}
	try {
		const pipeline = redis.redis.multi()
		pipeline.lpush(RECEIPTS_KEY, JSON.stringify(receipt))
		pipeline.ltrim(RECEIPTS_KEY, 0, RECEIPTS_MAX - 1)
		await pipeline.exec()
	} catch { /* Redis blip: the delivery outcome below stays honest */ }

	if (failRequested) {
		return json({ ok: false, reason: 'simulated receiver outage' }, { status: 500 })
	}
	return json({ ok: true })
}
