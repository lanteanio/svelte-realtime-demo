/**
 * POST /api/demos/news/webhook - HTTP-to-stream bridge for /demos/news.
 *
 * Mirrors the README's `live.webhook()` example: forward raw body +
 * lowercased headers to the handler, return whatever status it produces.
 * The handler verifies the HMAC signature, parses JSON, transforms the
 * payload into a `{ event, data }` pair, and the framework publishes it
 * to TOPICS.demoNewsStories so all subscribing pages see the new entry.
 *
 * The /demos/news page hits this endpoint directly via fetch with a
 * payload + signature obtained from the `signPublish` RPC. In a
 * production setting an external CMS (or a webhook from a third party
 * holding the shared secret) would POST here; the demo just proxies the
 * signing step server-side for convenience.
 */

import { newsWebhook } from '$live/demos/news'

export async function POST({ request, platform }) {
	const body = await request.text()
	const headers = Object.fromEntries(request.headers)
	const result = await newsWebhook.handle({ body, headers, platform })
	return new Response(result.body ?? '', { status: result.status })
}
