import { withBuildLock } from './build-lock.mjs'
import { viteBuild } from './vite-build.mjs'

// One build at a time in this checkout. Every build goes through this script,
// so taking the lock here covers a tier's build racing a hand-run
// `npm run build` as well as two tiers racing each other. See build-lock.mjs
// for what the collision looks like from the inside.
const LOCK = 'node_modules/.cache/srd-build.lock'

process.exitCode = await withBuildLock(LOCK, () => viteBuild())
