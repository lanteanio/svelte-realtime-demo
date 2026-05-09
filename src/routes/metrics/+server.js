/**
 * GET /metrics -- Prometheus text exposition format.
 *
 * Scrape-time, no continuous accounting on the publish hot path.
 * Production deployments should gate this endpoint behind their
 * monitoring scraper's source IP or a shared secret.
 */
import { metrics } from '$lib/server/metrics'

export function GET() {
	return new Response(metrics.serialize(), {
		headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }
	})
}
