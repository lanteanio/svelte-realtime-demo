import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const scripts = new URL('../../scripts/', import.meta.url)
const record = `printf '%s\\t' "$@" >> "$PWD/commands.log"
printf '\\n' >> "$PWD/commands.log"
`

for (const mode of ['success', 'smoke failure', 'health timeout']) {
	test(`deployment selects checked Compose files through ${mode}`, async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'deploy-compose-'))
		try {
			await mkdir(join(fixture, 'scripts'))
			await mkdir(join(fixture, 'bin'))
			for (const name of ['deploy.sh', 'compose-health.sh']) {
				await copyFile(new URL(name, scripts), join(fixture, 'scripts', name))
			}
			for (const name of ['docker-compose.yml', 'docker-compose.rollback.yml', 'compose.yaml', 'docker-compose.override.yml', 'ambient.yml']) {
				await writeFile(join(fixture, name), 'services: {}\n')
			}
			await writeFile(join(fixture, 'bin', 'git'), `#!/bin/bash
if [ "$1" = rev-parse ]; then echo new-revision; fi
`, { mode: 0o755 })
			await writeFile(join(fixture, 'bin', 'docker'), `#!/bin/bash
${record}
if [ "$1" = compose ]; then
  case " $* " in *" ps "*) echo app-container;; esac
elif [ "$1" = inspect ]; then
  case "$3" in
    *Config.Image*) echo previous-image;;
    *State.Running*) echo true;;
    *State.Health*) echo healthy;;
    *) exit 2;;
  esac
fi
`, { mode: 0o755 })
			await writeFile(join(fixture, 'bin', 'node'), `#!/bin/bash
${record}
if [ "$FAIL_SMOKE" = 1 ] && [ ! -f "$PWD/smoke-failed" ]; then
  touch "$PWD/smoke-failed"
  exit 1
fi
`, { mode: 0o755 })
			const run = spawnSync(bash, ['-c', 'export PATH="$PWD/bin:$PATH"; test "$(command -v docker)" = "$PWD/bin/docker" && test "$(command -v git)" = "$PWD/bin/git" && test "$(command -v node)" = "$PWD/bin/node" && exec bash scripts/deploy.sh'], {
				cwd: fixture, encoding: 'utf8', timeout: 15_000,
				env: { ...process.env, COMPOSE_FILE: 'ambient.yml', DEPLOY_BASE_URL: 'https://example.test', APP_REPLICAS: '1', DEPLOY_TIMEOUT_SECONDS: mode === 'health timeout' ? '0' : '3', FAIL_SMOKE: mode === 'smoke failure' ? '1' : '0' }
			})
			assert.equal(run.error, undefined)
			assert.equal(run.status, mode === 'success' ? 0 : 1, run.stdout + run.stderr)
			const calls = (await readFile(join(fixture, 'commands.log'), 'utf8')).trim().split('\n').map(line => line.trim().split('\t'))
			const compose = calls.filter(args => args[0] === 'compose')
			assert.ok(compose.length >= 5, 'deployment must reach rollout and its checks')
			let rollouts = 0
			for (const args of compose) {
				const files = []
				let index = 1
				while (args[index] === '-f') { files.push(args[index + 1]); index += 2 }
				if (args[index] === 'up') rollouts++
				assert.deepEqual(files, rollouts === 2
					? ['docker-compose.yml', 'docker-compose.rollback.yml']
					: ['docker-compose.yml'], args.join(' '))
			}
			assert.equal(rollouts, mode === 'success' ? 1 : 2)
			for (const command of ['build', 'run', 'up']) assert.ok(compose.some(args => args.includes(command)), command)
			assert.equal(compose.some(args => args.includes('docker-compose.rollback.yml')), mode !== 'success')
			if (mode === 'success') assert.ok(compose.some(args => args.includes('logs')))
			if (mode === 'smoke failure') {
				assert.ok(compose.some(args => args.includes('docker-compose.rollback.yml') && args.includes('ps')))
				assert.ok(calls.some(args => args.includes('--skip-readiness')))
			}
			if (mode === 'health timeout') assert.ok(compose.some(args => args.at(-2) === 'ps' && args.at(-1) === 'app'))
		} finally {
			await rm(fixture, { recursive: true, force: true })
		}
	})
}
