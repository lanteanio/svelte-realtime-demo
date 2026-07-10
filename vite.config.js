/**
 * Vite configuration.
 *
 * Plugins (order matters):
 * 1. sveltekit() -- SvelteKit's Vite plugin
 * 2. tailwindcss() -- Tailwind CSS v4 (with DaisyUI loaded via app.css)
 * 3. uws() -- WebSocket dev server (proxies WS to the adapter in dev mode)
 * 4. realtime() -- Transforms $live imports into RPC/stream client code
 */
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import uws from 'svelte-adapter-uws/vite'
import realtime from 'svelte-realtime/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	// Local Playwright writes traces/reports under the project root. Those
	// artifacts are not application inputs and must not trigger a full browser
	// reload in the middle of an assertion.
	server: {
		watch: {
			ignored: ['**/playwright-report/**', '**/test-results/**', '**/audits/**']
		}
	},
	// The cursor client is first imported by the lazily visited board route.
	// Pre-bundle all client-side runtime seams so first navigation cannot make
	// Vite discover a new common chunk and reload an already-hydrating page.
	optimizeDeps: {
		include: [
			'svelte-adapter-uws/client',
			'svelte-adapter-uws/plugins/presence/client',
			'svelte-adapter-uws/plugins/cursor/client',
			'svelte-realtime/client',
			'lucide-svelte'
		]
	},
	// Explicit `sourcemap: false` so a future config drift cannot ship
	// server-source maps to production.
	build: {
		sourcemap: false
	},
	plugins: [
		sveltekit(),
		tailwindcss(),
		uws(),
		realtime(),
		{
			name: 'first-load-hint',
			configureServer() {
				console.log('[demo] First page load compiles all modules on demand -- expect 5-10 seconds. Subsequent loads are instant.')
			}
		}
	]
})
