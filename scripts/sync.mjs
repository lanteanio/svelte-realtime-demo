import { spawn } from 'node:child_process'
import { withBuildLock } from './build-lock.mjs'

// `svelte-kit sync` loads svelte.config.js through vite as a build, so every
// run rewrites kit's generated server file under .svelte-kit/generated with a
// version of its own. A build reads that file between its own sync and its
// server build, and a sync landing in that window leaves the build's two
// halves on different version hashes (scripts/build-output.mjs fails such a
// build). Run under the lock scripts/build.mjs takes, a sync started during a
// build waits for it, and a build started during a sync waits for the sync.
const LOCK = 'node_modules/.cache/srd-build.lock'

// Resolves the sync's exit code; a spawn failure or a signal resolves 1.
process.exitCode = await withBuildLock(LOCK, () => new Promise((resolve) => {
	const child = spawn(process.execPath, ['node_modules/@sveltejs/kit/svelte-kit.js', 'sync'], { stdio: 'inherit' })
	child.once('error', (error) => {
		console.error(error)
		resolve(1)
	})
	child.once('exit', (code, signal) => {
		if (signal) {
			console.error(`svelte-kit sync terminated by ${signal}`)
			resolve(1)
		} else {
			resolve(code ?? 1)
		}
	})
}))
