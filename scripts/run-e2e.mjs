import { spawn } from 'node:child_process'

const CORE_PROJECTS = new Set(['main', 'isolated'])
const OPTIONAL_PROJECTS = new Set(['cluster', 'stress', 'destroyer', 'diagnostics'])
const requested = process.argv.slice(2)

if (requested.length === 0 || requested.some((name) => !CORE_PROJECTS.has(name) && !OPTIONAL_PROJECTS.has(name))) {
	console.error('Usage: node scripts/run-e2e.mjs <main|isolated|cluster|stress|destroyer|diagnostics> [...]')
	process.exit(2)
}

if (requested.includes('destroyer') && process.env.ALLOW_DESTRUCTIVE_E2E !== '1') {
	console.error('Refusing the 10K-connection destroyer. Set ALLOW_DESTRUCTIVE_E2E=1 to confirm this load test.')
	process.exit(2)
}

for (const project of requested) {
	const env = { ...process.env }
	if (OPTIONAL_PROJECTS.has(project)) env.E2E_OPTIONAL_PROJECT = project
	if (project === 'destroyer') env.RUN_DESTROYER = '1'

	const status = await run(process.execPath, [
		'node_modules/@playwright/test/cli.js',
		'test',
		`--project=${project}`
	], env)
	if (status !== 0) process.exit(status)
}

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`Playwright terminated by ${signal}`))
			else resolve(code ?? 1)
		})
	})
}
