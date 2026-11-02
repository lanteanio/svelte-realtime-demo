/**
 * SvelteKit configuration.
 *
 * Uses svelte-adapter-uws instead of the default Node adapter. This gives
 * us native WebSocket support via uWebSockets.js -- the fastest WebSocket
 * library available for Node.
 *
 * Upgrade admission bounds handshake work and live sockets per worker.
 */
import adapter from 'svelte-adapter-uws'
import { buildOutDir } from './scripts/build-output.mjs'
import { websocketAdmission } from './scripts/websocket-admission.mjs'

// Optional multi-hostname allowlist, for a deployment reachable under more
// than one name (an apex plus www, a staging alias). Comma-separated, each
// entry a full origin: ALLOWED_ORIGINS=https://example.com,https://www.example.com
//
// This is build-time adapter configuration, so it is read when the bundle is
// built rather than when the container starts. A deployment reachable under a
// single hostname needs none of it: left unset, the policy stays 'same-origin'
// and the runtime ORIGIN env is the authoritative pin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean)

// Where the built server is written. `build/` for everything that ships; the
// e2e harness overrides it per run, because Node ESM lazy-loads a route's
// server chunk on the FIRST request to that route, which makes the on-disk
// tree a live dependency of the running server for the whole tier rather than
// only at boot. A second build in the same checkout rewrites the chunk
// filenames the running server's manifest already points at, and the next cold
// route dies with ERR_MODULE_NOT_FOUND while warm routes keep passing out of
// the module cache. Nothing in the tier's output says a rebuild happened.
// scripts/build.mjs checks what the build wrote to the same directory.
const out = buildOutDir()

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		// Every evaluation of this config inside one build must agree on
		// version.name: the client bundle reads its hydration payload from
		// globalThis.__sveltekit_<hash(version.name)>, and kit's default is
		// Date.now() at evaluation time - so a config evaluated twice within
		// a build can ship a client that reads another evaluation's global
		// and hydrates nothing on any page. scripts/vite-build.mjs pins the
		// value once per build invocation; the fallback keeps ad-hoc builds
		// working with today's semantics (one fresh version per build).
		version: { name: process.env.SRD_BUILD_VERSION || String(Date.now()) },
		adapter: adapter({
			out,
			// The app ships its own /healthz route with per-dependency readiness
			// (Postgres incl. applied migrations, Redis) - the adapter's built-in
			// liveness probe would shadow it, so it is disabled. /readyz stays on:
			// it is the only probe that knows about graceful drain (503 the moment
			// shutdown begins), which the app route cannot see.
			healthCheckPath: false,
			readinessCheckPath: '/readyz',
			websocket: {
				// `metrics: './src/lib/server/metrics.js'` is deliberately NOT
				// set. Pointing the adapter at that module makes it bundle a
				// second, standalone copy: `platform.metrics` and the registry
				// the app imports become different objects, so the adapter's
				// counters never reach /metrics, and the module's own
				// `live.metrics(...)` registration runs a second time at boot.
				// The refusals the adapter makes before the upgrade hook runs
				// are therefore visible in its log output rather than as a
				// counter; the hook's own refusals are counted by the app.
				//
				// Present only when ALLOWED_ORIGINS was set at build time;
				// otherwise the adapter keeps its 'same-origin' default.
				...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
				...websocketAdmission(),
				// Demo pressure thresholds. publishRatePerSec matches the
				// adapter's production-tuned default (10000) -- the prior
				// 500 was tuned for /demos/pressure to artificially trip
				// PUBLISH_RATE on a single-user burst, but at real cluster
				// scale (125K cursor RPCs/sec + receiver-aggregation relay)
				// 500 was constantly tripped, shedding ~70% of joinBoard
				// admissions for legitimate stress traffic. /demos/pressure
				// can still trip the gate at 10000 if it bursts hard enough
				// (3.3K/sec sustained for 1.5s tops the gate naturally on
				// dynamic-derived watchers, which fan out per source-frame).
				// memoryHeapUsedRatio raised to 0.97 so the tiny V8 heap at
				// startup (~32 MB heap_total, ~28 MB heap_used = 87%) does
				// not permanently pin the reason at MEMORY.
				pressure: {
					publishRatePerSec: 10000,
					memoryHeapUsedRatio: 0.97
				}
				// permessage-deflate (`compression`) intentionally left at
				// uWS default (DISABLED=0). Empirical at 1000-cursor stress
				// on this box: both SHARED_COMPRESSOR=1 and
				// DEDICATED_COMPRESSOR_3KB=9 saturated the available CPU on
				// the deflate path; TLS handshake time climbed from ~100ms
				// to 8+s during sustain. Wire-byte reduction at this scale
				// belongs at the wire-format layer, not in deflate.

			}
		})
	},
	vitePlugin: {
		// Enable Svelte 5 runes mode for all project files (not node_modules)
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
}

export default config
