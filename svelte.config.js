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
					maxConcurrent: 1000,
					perTickBudget: 64
				},
				// Demo pressure thresholds. The adapter ships production-
				// tuned defaults (publishRatePerSec: 10000, memoryHeapUsedRatio:
				// 0.85) which never trip in a single-user dev / demo. We
				// lower publishRatePerSec to 500 so the +1000 / +5000
				// burst reliably trips PUBLISH_RATE, and raise
				// memoryHeapUsedRatio to 0.97 so the tiny V8 heap at
				// startup (~32 MB heap_total, ~28 MB heap_used = 87%)
				// does not permanently pin the reason at MEMORY.
				pressure: {
					publishRatePerSec: 500,
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
