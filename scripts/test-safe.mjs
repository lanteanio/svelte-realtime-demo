import { spawn } from 'node:child_process'

const steps = ['check', 'test:unit', 'build', 'test:e2e:safe']
const npmCli = process.env.npm_execpath

for (const step of steps) {
	console.log(`\n> verification: ${step}`)
	const status = npmCli
		? await run(process.execPath, [npmCli, 'run', step])
		: await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', step], process.platform === 'win32')
	if (status !== 0) process.exit(status)
}

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
