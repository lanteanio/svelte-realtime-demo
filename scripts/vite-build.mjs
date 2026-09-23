import { spawn as nodeSpawn } from 'node:child_process'

/**
 * The environment `vite build` runs under, derived once per build invocation.
 * @param {NodeJS.ProcessEnv} base
 */
export function buildEnvironment(base) {
	return {
		...base,
		// SvelteKit's post-build analysis imports server chunks under
		// NODE_ENV=production. Supply an analysis-only value when the operator
		// has not provided the real runtime secret. Production startup still
		// reads its own environment.
		DEMO_NEWS_WEBHOOK_SECRET: base.DEMO_NEWS_WEBHOOK_SECRET || 'build-analysis-only',
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
		SRD_BUILD_VERSION: base.SRD_BUILD_VERSION || String(Date.now())
	}
}

/**
 * Run `vite build` in a child process under `buildEnvironment(base)`.
 * Resolves the exit code; a spawn failure or a signal resolves 1.
 * `spawn` is replaceable so a test can see exactly what the child is handed.
 * @param {{
 *   base?: NodeJS.ProcessEnv,
 *   spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv, stdio: 'inherit' }) => import('node:events').EventEmitter
 * }} [options]
 * @returns {Promise<number>}
 */
export function viteBuild({ base = process.env, spawn = nodeSpawn } = {}) {
	const env = buildEnvironment(base)
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
