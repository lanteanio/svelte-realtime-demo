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
 */
import adapter from 'svelte-adapter-uws'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			websocket: {
				upgradeRateLimit: 0
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
