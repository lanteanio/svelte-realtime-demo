import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export function maintenanceOrigin(value) {
	const url = new URL(value)
	const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Use an HTTPS origin without credentials, path, query or fragment; HTTP is limited to loopback fixtures.')
	}
	return url.origin
}

export function failureWindows(samples) {
	const windows = []
	let previousSuccess = null
	let current = null
	for (const sample of samples) {
		if (sample.status === 200 && !sample.error) {
			if (current) {
				current.firstRecoveredProbe = { startedAt: sample.startedAt, finishedAt: sample.finishedAt }
				current.probeStartSpanMs = Date.parse(sample.startedAt) - Date.parse(current.firstFailedProbe.startedAt)
				current = null
			}
			previousSuccess = { startedAt: sample.startedAt, finishedAt: sample.finishedAt }
		} else {
			if (!current) {
				current = { previousSuccessfulProbe: previousSuccess, firstFailedProbe: { startedAt: sample.startedAt, finishedAt: sample.finishedAt }, lastFailedProbe: null, firstRecoveredProbe: null, probeStartSpanMs: null }
				windows.push(current)
			}
			current.lastFailedProbe = { startedAt: sample.startedAt, finishedAt: sample.finishedAt }
		}
	}
	return windows
}

export async function readinessProbe(origin) {
	const response = await fetch(new URL('/readyz', origin), { signal: AbortSignal.timeout(3000), redirect: 'error', cache: 'no-store' })
	await response.body?.cancel()
	return response.status
}

export function startMaintenanceMonitor({ origin, persist, probe = readinessProbe, smoke, intervalMs = 2000, now = () => new Date().toISOString() }) {
	const state = { origin: maintenanceOrigin(origin), startedAt: now(), finishedAt: null, outcome: 'monitoring', samples: [], smokeAttempts: [], failureWindows: [] }
	const wake = new AbortController()
	let stopped = false
	let completing = false
	let serial = Promise.resolve()
	const save = () => persist(JSON.parse(JSON.stringify({ ...state, failureWindows: failureWindows(state.samples) })))
	function markStopped(outcome) {
		if (!stopped) { stopped = true; state.outcome = outcome; wake.abort() }
	}
	function sample(finishOnSuccess = false) {
		const work = serial.then(async () => {
			if (stopped) return null
			const observation = { startedAt: now(), finishedAt: null, status: null, error: null }
			try { observation.status = await probe(state.origin) }
			catch (error) { observation.error = error?.name ?? 'Error' }
			observation.finishedAt = now()
			state.samples.push(observation)
			if (finishOnSuccess && observation.status === 200 && !observation.error) markStopped('complete')
			await save()
			return observation
		})
		serial = work.catch(() => {})
		return work
	}
	const done = (async () => {
		await save()
		while (!stopped) {
			await sample()
			if (!stopped) await delay(intervalMs, undefined, { signal: wake.signal }).catch(error => { if (error.name !== 'AbortError') throw error })
		}
		await serial
		state.finishedAt = now()
		await save()
		return { ...state, failureWindows: failureWindows(state.samples) }
	})()
	function stop(outcome = 'aborted') {
		markStopped(outcome)
		return done
	}
	return {
		done,
		stop,
		async complete() {
			if (stopped || completing) return false
			completing = true
			try {
				const attempt = { startedAt: now(), finishedAt: null, passed: false }
				try { attempt.passed = await smoke(state.origin) === true }
				catch (error) { attempt.error = error?.name ?? 'Error' }
				attempt.finishedAt = now()
				state.smokeAttempts.push(attempt)
				await save()
				if (!attempt.passed || stopped) return false
				const readiness = await sample(true)
				if (!readiness || state.outcome !== 'complete') return false
				await done
				return true
			} finally { completing = false }
		}
	}
}

async function main() {
	if (process.argv.length !== 4) throw new Error('usage: node scripts/maintenance-monitor.mjs https://your-domain.example private-readiness.json')
	const origin = maintenanceOrigin(process.argv[2])
	const output = resolve(process.argv[3])
	const reserved = await open(output, 'wx', 0o600)
	await reserved.close()
	let writeQueue = Promise.resolve()
	const persist = record => {
		writeQueue = writeQueue.then(async () => {
			const temporary = `${output}.${randomUUID()}.tmp`
			await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
			await rename(temporary, output)
		})
		return writeQueue
	}
	const smoke = target => new Promise(resolveSmoke => {
		execFile(process.execPath, [fileURLToPath(new URL('./deployment-smoke.mjs', import.meta.url)), target], { timeout: 35000, maxBuffer: 65536 }, error => resolveSmoke(!error))
	})
	const monitor = startMaintenanceMonitor({ origin, persist, smoke })
	const input = createInterface({ input: process.stdin, output: process.stdout })
	const abort = () => { void monitor.stop('aborted') }
	process.once('SIGINT', abort)
	process.once('SIGTERM', abort)
	const deadline = setTimeout(() => { void monitor.stop('deadline') }, 30 * 60 * 1000)
	console.log('Sampling /readyz. Keep this process running through host postflight failures.')
	console.log('After host postflight passes, press Enter to run the external smoke. A failed smoke keeps sampling; Enter retries it. Ctrl+C aborts without marking completion.')
	input.on('line', () => {
		void monitor.complete().then(passed => console.log(passed ? 'External smoke and readiness passed; capture completed.' : 'Completion checks did not pass; sampling continues.')).catch(error => { console.error(error.name); void monitor.stop('error') })
	})
	try {
		const result = await monitor.done
		console.log(`Capture ${result.outcome}: ${output}`)
		console.log('Failure windows describe sampled observations, not exact continuous downtime between probes.')
		if (result.outcome !== 'complete') process.exitCode = 1
	} finally {
		clearTimeout(deadline)
		input.close()
		process.off('SIGINT', abort)
		process.off('SIGTERM', abort)
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
