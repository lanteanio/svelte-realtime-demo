import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a build writes the app: `build/` for everything that ships, or
 * BUILD_OUT_DIR, which the e2e harness sets per run (svelte.config.js says
 * why). svelte.config.js hands it to the adapter, and scripts/build.mjs checks
 * what the build wrote there.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildOutDir(env = process.env) {
	return env.BUILD_OUT_DIR || 'build'
}

/**
 * Every .js file under `dir`, source maps left out. A directory that does not
 * exist holds none.
 * @param {string} dir
 * @returns {string[]}
 */
function scriptsUnder(dir) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
		throw error
	}
	return entries.flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return scriptsUnder(path)
		return entry.isFile() && entry.name.endsWith('.js') ? [path] : []
	})
}

/** Names kit gives other globals under the __sveltekit_ prefix. */
const KIT_GLOBALS = new Set(['dev', 'sw'])

/**
 * The distinct first capture of `pattern` across every .js file under `dir`.
 * @param {string} dir
 * @param {RegExp} pattern a global pattern with one capture group
 */
function hashesUnder(dir, pattern) {
	const hashes = new Set()
	for (const file of scriptsUnder(dir)) {
		for (const match of readFileSync(file, 'utf8').matchAll(pattern)) hashes.add(match[1])
	}
	return [...hashes].sort()
}

/**
 * Check that the two halves of a finished build agree on its version hash.
 *
 * The server renders every page with its hydration payload in
 * globalThis.__sveltekit_<hash>, taking the hash from kit's generated server
 * file, which the server build reads from disk under .svelte-kit/generated.
 * The client reads the global under the hash it was compiled with, which the
 * client build holds in memory. A write to that file from another process
 * that lands after the build's own sync has written it and before the server
 * build reads it leaves a server defining one global and a client reading
 * another, and every page renders and then hydrates nothing; vite's output
 * gives no sign of it.
 *
 * Other processes in this checkout can make such a write, each with a version
 * of its own. `svelte-kit sync` loads the config through vite as a build and
 * writes the file every time it runs; `npm run check` and npm's prepare step
 * run it through scripts/sync.mjs, under the build lock, so only a sync started
 * some other way (by hand, through npx) can land inside a build. A vite build
 * started directly rather than through scripts/build.mjs takes no lock and
 * writes the file as it starts and again from its analyse and prerender steps,
 * which load the config anew; unpinned, each of those writes carries a version
 * of its own. A vite dev server takes no lock either and writes it when it
 * starts and when it restarts (as it does on an edit to svelte.config.js, the
 * vite config or .env), each time under a fresh version. While it runs, its
 * syncs write the file only when the text differs
 * from what that process last wrote, which is once app.html has changed, the
 * server or universal hooks file has been created, deleted or renamed, or the
 * service worker has come or gone. Edits to the contents of the hooks, the
 * service worker or error.html leave the text as it was and make no write.
 *
 * The hashes are read as kit spells them in the built files:
 * `version_hash: "<hash>"` in the server, `__sveltekit_<hash>` in the client.
 * Two names kit gives other globals under the same prefix, __sveltekit_dev and
 * __sveltekit_sw, are not hashes and are skipped. A half in which no hash is
 * found fails the check as well, because a check that finds nothing to compare
 * has not compared anything.
 *
 * @param {string} out the build's output directory
 * @returns {string | null} what is wrong, or null when the halves agree
 */
export function versionHashMismatch(out) {
	const serverDir = join(out, 'server')
	const clientDir = join(out, 'client')
	const server = hashesUnder(serverDir, /\bversion_hash:\s*"([0-9a-z]+)"/g)
	const client = hashesUnder(clientDir, /\b__sveltekit_([0-9a-z]+)\b/g).filter((name) => !KIT_GLOBALS.has(name))
	const respell = 'either the build wrote nothing there, or kit spells it differently now and scripts/build-output.mjs has to follow'
	if (server.length === 0) return `no version_hash: "<hash>" found in the .js files under ${serverDir}: ${respell}.`
	if (client.length === 0) return `no __sveltekit_<hash> found in the .js files under ${clientDir}: ${respell}.`
	if (server.length > 1) return `the server under ${serverDir} carries more than one version_hash (${server.join(', ')}), so the hash its pages define cannot be told.`
	const [hash] = server
	if (client.length === 1 && client[0] === hash) return null
	return (
		`the server defines its hydration payload as __sveltekit_${hash}, but the client reads ` +
		`${client.map((h) => `__sveltekit_${h}`).join(' and ')}, so every page would render and then hydrate nothing. ` +
		'Kit\'s generated server file (.svelte-kit/generated/server/internal.js) was rewritten while this build ran, ' +
		'most likely by a svelte-kit sync started outside npm run check (by hand or through npx), by a vite build ' +
		'started outside scripts/build.mjs, or by a vite dev server in this checkout. Build again while none of those ' +
		'runs here.'
	)
}
