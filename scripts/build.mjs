import { spawn } from 'node:child_process'
import { withBuildLock } from './build-lock.mjs'

// SvelteKit's post-build analysis imports server chunks under NODE_ENV=production.
// Supply an analysis-only value when the operator has not provided the real
// runtime secret. Production startup still reads its own environment.
const env = {
	...process.env,
	DEMO_NEWS_WEBHOOK_SECRET: process.env.DEMO_NEWS_WEBHOOK_SECRET || 'build-analysis-only',
	// Pinned HERE, once per build invocation, because svelte.config.js may be
	// evaluated more than once inside a single vite build - and kit's default
	// for version.name is Date.now() at config evaluation. The client bundle
	// compiles its payload access to globalThis.__sveltekit_<hash(version.name)>
	// while the server renders HTML defining the same global from ITS
	// evaluation; two evaluations that disagree ship a client reading another
	// build's global, and every page dies at hydration on
	// `Cannot read properties of undefined (reading 'data')` - observed as a
	// 61-of-81 cluster-tier wall on a tree the main tier passed. With the
	// value pinned in the environment, every evaluation agrees by
	// construction, and version semantics are unchanged: one fresh version
	// per build invocation.
	SRD_BUILD_VERSION: process.env.SRD_BUILD_VERSION || String(Date.now())
}

// One build at a time in this checkout. Every build goes through this script,
// so taking the lock here covers a tier's build racing a hand-run
// `npm run build` as well as two tiers racing each other. See build-lock.mjs
// for what the collision looks like from the inside.
const LOCK = 'node_modules/.cache/srd-build.lock'

process.exitCode = await withBuildLock(LOCK, viteBuild)

function viteBuild() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
			env,
			stdio: 'inherit'
		})
		child.once('error', (error) => {
			console.error(error)
			resolve(1)
		})
		child.once('exit', (code, signal) => {
			if (signal) {
				console.error(`vite build terminated by ${signal}`)
				resolve(1)
			} else {
				resolve(code ?? 1)
			}
		})
	})
}
