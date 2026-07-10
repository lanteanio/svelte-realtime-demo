import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')
const SKIP = new Set(['.git', '.svelte-kit', 'build', 'node_modules', 'playwright-report', 'test-results'])
const files = []

await collect(ROOT)

for (const file of files) {
	const status = await run(process.execPath, ['--check', file])
	if (status !== 0) {
		console.error(`JavaScript syntax check failed: ${relative(ROOT, file)}`)
		process.exit(status)
	}
}

console.log(`JavaScript syntax: ${files.length} files checked`)

async function collect(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) await collect(join(dir, entry.name))
		} else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
			files.push(join(dir, entry.name))
		}
	}
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`node --check terminated by ${signal}`))
			else resolve(code ?? 1)
		})
	})
}
