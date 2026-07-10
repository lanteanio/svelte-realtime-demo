import { spawn } from 'node:child_process'

const steps = ['check', 'test:unit', 'build', 'test:e2e:complete']
const npmCli = process.env.npm_execpath
const results = []

for (const step of steps) {
	console.log(`\n> verification: ${step}`)
	const status = npmCli
		? await run(process.execPath, [npmCli, 'run', step])
		: await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', step], process.platform === 'win32')
	results.push({ step, status })
}

console.log('\nComplete verification summary')
for (const result of results) {
	console.log(`  ${result.status === 0 ? 'PASS' : 'FAIL'}  ${result.step}`)
}
process.exitCode = results.every((result) => result.status === 0) ? 0 : 1

function run(command, args, shell = false) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (signal) reject(new Error(`${command} terminated by ${signal}`))
			else resolve(code ?? 1)
		})
	})
}
