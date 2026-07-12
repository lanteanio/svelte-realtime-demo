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
 * Signature verification follows the documented receiver contract: the
 * header carries one or more comma-separated `sha256=<hex>` entries
 * (two during a key rotation, current key first); accept when ANY
 * entry matches, comparing timing-safe. An invalid signature is still
 * recorded (with `sigValid: false`) rather than rejected, so the page
 * can SHOW the verification result - a real receiver would return 401
 * and process nothing.
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

import { createHmac, timingSafeEqual } from 'node:crypto'
import { json } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

const RECEIPTS_KEY = 'demos:outbound:receipts'
const RECEIPTS_MAX = 30

const WEBHOOK_SECRET = process.env.DEMO_OUTBOUND_WEBHOOK_SECRET || 'demo-outbound-secret'

/**
 * True when any comma-separated `sha256=<hex>` entry in the header
 * matches the HMAC-SHA256 of the raw body under the shared secret.
 * Length mismatch is itself a failure (timingSafeEqual requires
 * equal-length buffers), checked before the constant-time compare.
 */
function signatureValid(body, header) {
	if (typeof header !== 'string' || header.length === 0) return false
	const expected = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
	const expectedBuf = Buffer.from(expected, 'utf8')
	for (const entry of header.split(',')) {
		const hex = entry.trim().startsWith('sha256=') ? entry.trim().slice(7) : entry.trim()
		if (hex.length !== expected.length) continue
		if (timingSafeEqual(Buffer.from(hex, 'utf8'), expectedBuf)) return true
	}
	return false
}

export async function POST({ request }) {
	const body = await request.text()
	const sigValid = signatureValid(body, request.headers.get('x-webhook-signature'))
	const idempotencyKey = request.headers.get('idempotency-key') ?? null

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
