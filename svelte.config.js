/**
 * SvelteKit configuration.
 *
 * Uses svelte-adapter-uws instead of the default Node adapter. This gives
 * us native WebSocket support via uWebSockets.js -- the fastest WebSocket
 * library available for Node.
 *
 * upgradeRateLimit: 0 disables the per-IP WebSocket upgrade rate limit.
 * This is needed for stress testing (1000 connections from one IP).
 * For production, set this to a reasonable value (e.g. 100).
 *
 * upgradeAdmission caps in-flight WebSocket upgrades at the handshake
 * layer. Surplus get a 503 BEFORE TLS / cookie / hook work, so a 10K
 * connection storm sheds cheap instead of burning CPU on doomed
 * upgrades. perTickBudget paces res.upgrade() calls so a synchronous
 * burst does not starve other I/O. 1000 / 64 lets the 1000-cursor
 * stress test pass through and trips the shed only past that.
 */
import adapter from 'svelte-adapter-uws'

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
const out = process.env.BUILD_OUT_DIR || 'build'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
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
				upgradeRateLimit: 0,
				// Same rationale as upgradeRateLimit: the stress harness drives
				// 1000+ connections from one IP, and the auth-preflight door
				// (default 30 per 10s per IP since adapter next.87) would refuse
				// most of them. For production behind real client IPs, set both
				// to reasonable values instead.
				authPathRateLimit: 0,
				upgradeAdmission: {
					// Cap in-flight upgrades. 4000 keeps the 1000-bot stress harness
					// (plus 4x burst-room above it) entirely on the cheap shed path.
					// perTickBudget scales to drain that pool within ~1s of event-
					// loop time on a 60Hz tick (4000 / 256 = ~16 ticks).
					maxConcurrent: 4000,
					perTickBudget: 256
				},
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
