import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const unitDirectory = new URL('../test/unit/', import.meta.url)
const files = (await readdir(unitDirectory))
	.filter((name) => name.endsWith('.test.js'))
	.sort()
	.map((name) => fileURLToPath(new URL(name, unitDirectory)))

if (files.length === 0) {
	console.error('No unit tests found under test/unit')
	process.exit(1)
}

const status = await new Promise((resolve, reject) => {
	const child = spawn(process.execPath, ['--test', ...files], {
		stdio: 'inherit',
		env: process.env
	})
	child.once('error', reject)
	child.once('exit', (code, signal) => {
		if (signal) reject(new Error(`unit tests terminated by ${signal}`))
		else resolve(code ?? 1)
	})
})

process.exitCode = status
