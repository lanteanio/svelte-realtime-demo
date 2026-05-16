/**
 * GET /metrics - Prometheus text exposition format.
 *
 * Scrape-time, no continuous accounting on the publish hot path. Gated by a
 * shared-secret token when `METRICS_SCRAPE_TOKEN` is set in the env: the
 * scraper must send `X-Scrape-Token: <secret>`. When the env var is unset
 * the endpoint is OPEN (existing deployments that scrape without auth keep
 * working unchanged); recommended that any deployment beyond a single
 * trusted host sets the token.
 */
import { error } from '@sveltejs/kit'
import { metrics } from '$lib/server/metrics'

export function GET({ request }) {
	const expected = process.env.METRICS_SCRAPE_TOKEN
	if (expected) {
		const provided = request.headers.get('x-scrape-token')
		if (provided !== expected) error(401, 'Unauthorized')
	}
	return new Response(metrics.serialize(), {
		headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }
	})
}
