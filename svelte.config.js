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

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			websocket: {
				upgradeRateLimit: 0,
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
