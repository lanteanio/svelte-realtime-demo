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
		dynamicCompileOptions: ({ filename }) =>
			filename.includes('node_modules') ? undefined : { runes: true }
	}
}

export default config
