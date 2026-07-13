/**
 * Guard against the "cron never registered" class of bug.
 *
 * The realtime Vite codegen only scans src/live/ for exports to emit into the
 * cron registry the runtime ticks. A live.cron() defined anywhere else keeps
 * its schedule metadata but is NEVER registered, so it silently never fires -
 * which is how the demo purge crons went un-run in production for weeks.
 *
 * This check fails the build if any `live.cron(` appears outside src/live/, so
 * a purge/orchestrator cron can never again be defined where the codegen will
 * not see it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')
const SRC = join(ROOT, 'src')
const LIVE = join(ROOT, 'src', 'live')
const SKIP = new Set(['.git', '.svelte-kit', 'build', 'node_modules', 'playwright-report', 'test-results'])
const CRON_RE = /\blive\s*\.\s*cron\s*\(/

const offenders = []
let liveCronCount = 0

await walk(SRC)

if (offenders.length > 0) {
	console.error('live.cron() found OUTSIDE src/live/ - the codegen will never register it, so it will never fire:')
	for (const f of offenders) console.error(`  ${f}`)
	console.error('Move the cron under src/live/ (see src/live/_purge.js).')
	process.exit(1)
}

console.log(`cron registration: ${liveCronCount} live.cron() export(s), all under src/live/`)

async function walk(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP.has(entry.name)) await walk(join(dir, entry.name))
		} else if (entry.isFile() && /\.(?:js|mjs|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
			const full = join(dir, entry.name)
			const text = await readFile(full, 'utf8')
			if (!CRON_RE.test(text)) continue
			if (full.startsWith(LIVE)) liveCronCount++
			else offenders.push(relative(ROOT, full))
		}
	}
}
