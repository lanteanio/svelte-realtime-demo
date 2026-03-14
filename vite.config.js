import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import uws from 'svelte-adapter-uws/vite'
import realtime from 'svelte-realtime/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [sveltekit(), tailwindcss(), uws(), realtime()]
})
