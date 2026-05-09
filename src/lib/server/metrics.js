/**
 * Prometheus metrics registry.
 *
 * Single registry shared by every instrumentation site:
 *
 * - live.metrics(...) wires RPC counters, durations, errors, stream
 *   subscription gauge, and cron counters from svelte-realtime.
 * - wirePublishRateMetrics(platform, metrics) wires per-topic
 *   publish-rate gauges (scraped from platform.pressure.topPublishers
 *   at scrape time, no continuous accounting on the publish hot path).
 * - connectionMetricsHook(metrics, close) wraps the close hook and
 *   emits per-connection histograms (duration, messages, bytes) plus
 *   a close-code counter.
 * - wireAssertionMetrics(metrics) increments a counter per assertion
 *   violation category (cardinality bounded by source-declared categories).
 *
 * Endpoint: GET /metrics serialises the registry to Prometheus text
 * exposition format. See src/routes/metrics/+server.js.
 *
 * The six-line `live.metrics({ counter, histogram, gauge })` shim adapts
 * realtime's options-object call shape to the extensions registry's
 * positional create methods. Once a metric is registered, every
 * increment, observation, and gauge update flows directly to the
 * extensions registry; emitted output is exactly what serialize()
 * produces.
 */

import { createMetrics, wireAssertionMetrics } from 'svelte-adapter-uws-extensions/prometheus'
import { live } from 'svelte-realtime/server'

export const metrics = createMetrics()

// Shim realtime's options-object create shape to the extensions
// registry's positional shape. Per the realtime README "Prometheus
// metrics" section.
live.metrics({
	counter: ({ name, help, labelNames }) => metrics.counter(name, help, labelNames),
	histogram: ({ name, help, labelNames }) => metrics.histogram(name, help, labelNames),
	gauge: ({ name, help, labelNames }) => metrics.gauge(name, help, labelNames)
})

// Production-assertion violations from the extensions package's own
// assert helper land here. Realtime's live.metrics already wired the
// realtime-side assertions; this covers extensions-side ones.
wireAssertionMetrics(metrics)
