import { spawn } from 'node:child_process'

// SvelteKit's post-build analysis imports server chunks under NODE_ENV=production.
// Supply an analysis-only value when the operator has not provided the real
// runtime secret. Production startup still reads its own environment.
const env = {
	...process.env,
	DEMO_NEWS_WEBHOOK_SECRET: process.env.DEMO_NEWS_WEBHOOK_SECRET || 'build-analysis-only'
}

const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
	env,
	stdio: 'inherit'
})
child.once('error', (error) => {
	console.error(error)
	process.exitCode = 1
})
child.once('exit', (code, signal) => {
	if (signal) {
		console.error(`vite build terminated by ${signal}`)
		process.exitCode = 1
	} else {
		process.exitCode = code ?? 1
	}
})
