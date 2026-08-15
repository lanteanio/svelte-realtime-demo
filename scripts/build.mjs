import { spawn } from 'node:child_process'
import { withBuildLock } from './build-lock.mjs'

// SvelteKit's post-build analysis imports server chunks under NODE_ENV=production.
// Supply an analysis-only value when the operator has not provided the real
// runtime secret. Production startup still reads its own environment.
const env = {
	...process.env,
	DEMO_NEWS_WEBHOOK_SECRET: process.env.DEMO_NEWS_WEBHOOK_SECRET || 'build-analysis-only'
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
