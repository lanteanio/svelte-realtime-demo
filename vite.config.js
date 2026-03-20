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
