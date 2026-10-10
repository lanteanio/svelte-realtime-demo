import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Each check script walks the tree above its own directory, so a copy of it
// placed at <fixture>/scripts/ checks <fixture> and nothing else. The fixture's
// directory name holds a space, a non-ASCII letter, a percent sign and a #,
// which a file URL's pathname spells percent-encoded; decodeURI leaves the #
// encoded.
function runCopyOf(name, files) {
	const dir = mkdtempSync(join(tmpdir(), `srd check ${String.fromCharCode(0xfc)}%41#-`))
	try {
		mkdirSync(join(dir, 'scripts'))
		copyFileSync(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)), join(dir, 'scripts', name))
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(dir, path, '..'), { recursive: true })
			writeFileSync(join(dir, path), text)
		}
		const run = spawnSync(process.execPath, [join(dir, 'scripts', name)], { encoding: 'utf8', timeout: 30_000 })
		return { status: run.status, output: `${run.stdout}\n${run.stderr}` }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const BROKEN = 'const = ;\n'
const CRON = 'export const tick = live.cron(\'* * * * *\', () => {})\n'
// Files with no live.cron() in them, inside src/live/ and outside it: neither
// is counted nor flagged.
const NO_CRON = { 'src/live/plain.js': 'export const value = 1\n', 'src/lib/util.js': 'export const value = 1\n' }

test('the syntax check does not read the harness\'s per-run build directories', { timeout: 60_000 }, () => {
	// What is checked: a file that fails node --check at
	// build-runs/srd-build-1/server/chunk.js leaves the check passing, with 2
	// files checked (src/ok.js and the script's own copy); the same file at
	// src/srd-build-1/server/chunk.js, a path that shares every directory name
	// but build-runs, fails the check, naming the file.
	const skipped = runCopyOf('check-js.mjs', { 'src/ok.js': 'export const ok = 1\n', 'build-runs/srd-build-1/server/chunk.js': BROKEN })
	assert.equal(skipped.status, 0, `a file under build-runs/ must not be checked: ${skipped.output}`)
	assert.match(skipped.output, /JavaScript syntax: 2 files checked/)
	const checked = runCopyOf('check-js.mjs', { 'src/ok.js': 'export const ok = 1\n', 'src/srd-build-1/server/chunk.js': BROKEN })
	assert.notEqual(checked.status, 0, `the same file outside build-runs/ must fail the check: ${checked.output}`)
	assert.match(checked.output, /JavaScript syntax check failed: src[\\/]srd-build-1[\\/]server[\\/]chunk\.js/)
})

test('the syntax check excludes root scratch files while checking nested application source', { timeout: 60_000 }, () => {
	const skipped = runCopyOf('check-js.mjs', { 'src/ok.js': 'export const ok = 1\n', 'source/retained/server.js': BROKEN })
	assert.equal(skipped.status, 0, skipped.output)
	assert.match(skipped.output, /JavaScript syntax: 2 files checked/)
	const checked = runCopyOf('check-js.mjs', { 'src/source/retained/server.js': BROKEN })
	assert.notEqual(checked.status, 0, checked.output)
	assert.match(checked.output, /JavaScript syntax check failed: src[\\/]source[\\/]retained[\\/]server\.js/)
})

test('the cron registration check reads a checkout whose path needs percent-encoding in a URL', { timeout: 60_000 }, () => {
	// What is checked: in such a checkout, with a live.cron() under src/live/
	// and a file without one both inside src/live/ and outside it, the check
	// passes and counts 1 file; adding a live.cron() under src/lib/ fails the
	// check, naming that file.
	const passing = runCopyOf('check-cron-registration.mjs', { 'src/live/jobs.js': CRON, ...NO_CRON })
	assert.equal(passing.status, 0, passing.output)
	assert.match(passing.output, /cron registration: 1 file\(s\) with live\.cron\(\), all under src\/live\//)
	const failing = runCopyOf('check-cron-registration.mjs', { 'src/live/jobs.js': CRON, ...NO_CRON, 'src/lib/server/jobs.js': CRON })
	assert.notEqual(failing.status, 0, failing.output)
	assert.match(failing.output, /src[\\/]lib[\\/]server[\\/]jobs\.js/)
})

test('the cron registration check flags a live.cron() in any file outside src/live/', { timeout: 60_000 }, () => {
	// What is checked: one checkout holding these offending files and a
	// live.cron() under src/live/ fails the check, the output names each
	// offending file, and it does not name the file under src/live/. The
	// offending files: src/live-extra/jobs.js (a sibling directory sharing the
	// stem); src/lib/live/schedule.mjs (a directory named live elsewhere, an
	// .mjs file, and a call that is not an exported const); src/lib/jobs.ts (a
	// .ts file); src/routes/api/jobs/+server.js (under src/routes/); and
	// src/hooks.server.js (directly in src/, its call spelled with mixed runs
	// of spaces and tabs before the dot, after it and before the paren).
	// Not looked at: .d.ts files, which the check skips on purpose, and calls spelled
	// across lines.
	const failing = runCopyOf('check-cron-registration.mjs', {
		'src/live/jobs.js': CRON,
		'src/live-extra/jobs.js': CRON,
		'src/lib/live/schedule.mjs': 'const tick = enabled ? live.cron(\'* * * * *\', () => {}) : null\n',
		'src/lib/jobs.ts': CRON,
		'src/routes/api/jobs/+server.js': CRON,
		'src/hooks.server.js': 'export const tick = live \t .\t  cron  \t(\'* * * * *\', () => {})\n'
	})
	assert.notEqual(failing.status, 0, failing.output)
	assert.match(failing.output, /src[\\/]live-extra[\\/]jobs\.js/)
	assert.match(failing.output, /src[\\/]lib[\\/]live[\\/]schedule\.mjs/)
	assert.match(failing.output, /src[\\/]lib[\\/]jobs\.ts/)
	assert.match(failing.output, /src[\\/]routes[\\/]api[\\/]jobs[\\/]\+server\.js/)
	assert.match(failing.output, /src[\\/]hooks\.server\.js/)
	assert.doesNotMatch(failing.output, /src[\\/]live[\\/]jobs\.js/)
})

test('the cron registration check ignores identifiers that only end in live', () => {
	const passing = runCopyOf('check-cron-registration.mjs', {
		'src/live/jobs.js': CRON,
		'src/lib/olive.js': CRON.replace('live.cron', 'olive.cron')
	})
	assert.equal(passing.status, 0, passing.output)
	assert.match(passing.output, /cron registration: 1 file\(s\) with live\.cron\(\), all under src\/live\//)
})
