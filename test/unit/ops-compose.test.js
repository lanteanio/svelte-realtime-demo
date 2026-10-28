import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const root = new URL('../../', import.meta.url)

for (const [script, mode, commands, status] of /** @type {Array<[string, string, string[], number]>} */ ([
	['reset-all.sh', 'success', ['ps', 'stop', 'exec', 'start', 'ps'], 0],
	['reset-all.sh', 'reset failure', ['ps', 'stop', 'exec', 'start', 'ps'], 7],
	['reset-all.sh', 'health timeout', ['ps', 'stop', 'exec', 'start', 'ps'], 1],
	['reset-db.sh', 'success', ['exec'], 0],
	['reset-redis.sh', 'success', ['exec'], 0],
	['renew-certs.sh', 'success', ['exec', 'exec'], 0],
	['renew-certs.sh', 'certificate failure', ['exec', 'exec', 'ps'], 1],
	['init-certs.sh', 'success', ['run'], 0]
])) {
	test(`${script} selects the base Compose file through ${mode}`, async () => {
		const fixture = await mkdtemp(join(tmpdir(), 'ops-compose-'))
		try {
			await mkdir(join(fixture, 'scripts'))
			await mkdir(join(fixture, 'bin'))
			for (const name of new Set([script, 'compose-health.sh', 'reset-lib.sh'])) {
				const source = await readFile(new URL(`scripts/${name}`, root), 'utf8')
				await writeFile(join(fixture, 'scripts', name), source.replace(/\r\n/g, '\n'))
			}
			for (const name of ['docker-compose.yml', 'compose.yaml', 'docker-compose.override.yml', 'ambient.yml']) {
				await writeFile(join(fixture, name), 'services: {}\n')
			}
			await writeFile(join(fixture, '.env'), 'COMPOSE_FILE=ambient.yml\nCOMPOSE_PROJECT_NAME=maintenance-test\n')
			await writeFile(join(fixture, 'bin', 'docker'), `#!/bin/bash
if [ "$1" = compose ]; then
  printf '%s\\0' "$@" >> "$PWD/commands.log"
  printf '\\0' >> "$PWD/commands.log"
  case " $* " in
    *" ps "*) echo app-container;;
    *" exec "*" redis "*) [ "$TEST_MODE" != 'reset failure' ] || exit 7;;
    *" /usr/local/bin/verify-served-cert "*) [ "$TEST_MODE" != 'certificate failure' ] || exit 8;;
  esac
elif [ "$1" = inspect ]; then
  case "$3" in
    *State.Running*) echo true;;
    *State.Health*) echo healthy;;
    *) exit 2;;
  esac
else
  exit 3
fi
`, { mode: 0o755 })
			const run = spawnSync(bash, ['-c', 'export PATH="$PWD/bin:$PATH"; test "$(command -v docker)" = "$PWD/bin/docker" && exec bash "scripts/$1" example.test test@example.test', '--', script], {
				cwd: fixture, encoding: 'utf8', timeout: 15_000,
				env: { ...process.env, COMPOSE_FILE: 'ambient.yml', COMPOSE_PROJECT_NAME: 'maintenance-test', CONFIRM: 'yes', TEST_MODE: mode, RESET_START_TIMEOUT_SECONDS: mode === 'health timeout' ? '0' : '3' }
			})
			assert.equal(run.error, undefined)
			assert.equal(run.status, status, run.stdout + run.stderr)
			const calls = (await readFile(join(fixture, 'commands.log'), 'utf8')).split('\0\0').filter(Boolean).map(call => call.split('\0'))
			for (const args of calls) assert.deepEqual(args.slice(0, 3), ['compose', '-f', 'docker-compose.yml'], args.join(' '))
			const executed = calls.map(args => args[3])
			let cursor = 0
			for (const command of commands) {
				cursor = executed.indexOf(command, cursor)
				assert.notEqual(cursor, -1, `must reach ${command}: ${executed.join(' ')}`)
				cursor++
			}
			if (script === 'reset-all.sh' && mode === 'success') assert.equal(calls.filter(args => args[3] === 'exec').length, 2)
		} finally {
			await rm(fixture, { recursive: true, force: true })
		}
	})
}

test('README Compose commands and health wait select the base file', async () => {
	const readme = await readFile(new URL('README.md', root), 'utf8')
	const calls = [...readme.matchAll(/docker compose[^\n]*/g)].map(match => match[0])
	assert.ok(calls.length > 10)
	for (const call of calls) assert.match(call, /^docker compose -f docker-compose\.yml\b/)
	const waits = readme.split('\n').filter(line => /^\s*wait_for_app_health /.test(line))
	assert.equal(waits.length, 1)
	assert.match(waits[0], / -f docker-compose\.yml\s*$/)
})
