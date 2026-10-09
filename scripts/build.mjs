import { withBuildLock } from './build-lock.mjs'
import { buildOutDir, versionHashMismatch } from './build-output.mjs'
import { viteBuild } from './vite-build.mjs'

// One build at a time in this checkout. Every build goes through this script,
// so taking the lock here covers a tier's build racing a hand-run
// `npm run build` as well as two tiers racing each other. See build-lock.mjs
// for what the collision looks like from the inside.
const LOCK = 'node_modules/.cache/srd-build.lock'

// A build vite reports as successful is checked before it counts as one: a
// writer outside the lock can still leave its two halves on different version
// hashes (build-output.mjs), and the result serves pages that never hydrate.
process.exitCode = await withBuildLock(LOCK, async () => {
	const code = await viteBuild()
	if (code !== 0) return code
	const problem = versionHashMismatch(buildOutDir())
	if (problem === null) return 0
	console.error(`build check failed: ${problem}`)
	return 1
})
