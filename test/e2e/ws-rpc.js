import { setTimeout as delay } from 'node:timers/promises'

/** Send one realtime RPC and wait for its correlated `__rpc` response. */
export function callRpc(ws, rpc, args, { timeoutMs = 10_000 } = {}) {
	return new Promise((resolve, reject) => {
		const id = `e2e-${crypto.randomUUID()}`
		const timer = setTimeout(() => finish(new Error(`${rpc} timed out`)), timeoutMs)

		function cleanup() {
			clearTimeout(timer)
			ws.off('message', onMessage)
			ws.off('close', onClose)
		}

		function finish(error, value) {
			cleanup()
			if (error) reject(error)
			else resolve(value)
		}

		function onClose() {
			finish(new Error(`${rpc} socket closed before its response`))
		}

		function onMessage(raw) {
			let envelope
			try {
				envelope = JSON.parse(raw.toString())
			} catch {
				return
			}
			if (envelope?.topic !== '__rpc' || envelope.event !== id) return
			if (envelope.data?.ok) finish(null, envelope.data.data)
			else finish(new Error(`${rpc} failed: ${envelope.data?.code ?? 'UNKNOWN'}`))
		}

		ws.on('message', onMessage)
		ws.once('close', onClose)
		ws.send(JSON.stringify({ rpc, id, args }), (error) => {
			if (error) finish(error)
		})
	})
}

/** Retry an idempotent board join without flooding a recovering dependency. */
export async function joinBoardWithRetry(ws, boardId, { attempts = 3 } = {}) {
	let lastError
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await callRpc(ws, 'boards/cursors/joinBoard', [boardId])
			return
		} catch (error) {
			lastError = error
			if (attempt < attempts) await delay(attempt * 500)
		}
	}
	throw lastError
}

/** The standard destroyer concurrency ramp; DESTROYER_LEVELS overrides it. */
const DEFAULT_DESTROYER_LEVELS = [1000, 2000, 3000, 5000, 7000, 10000]

/**
 * Parse DESTROYER_LEVELS into a validated increasing ramp of concurrency
 * levels (the standard ramp when unset). Throws if the override is not an
 * increasing comma-separated list starting at 1000.
 */
export function destroyerLevels(env = process.env) {
	const levels = env.DESTROYER_LEVELS
		? env.DESTROYER_LEVELS.split(',').map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite)
		: DEFAULT_DESTROYER_LEVELS
	if (levels.length === 0 || levels.some((level, index) => level < 1000 || (index > 0 && level <= levels[index - 1]))) {
		throw new Error('DESTROYER_LEVELS must be an increasing comma-separated list starting at 1000')
	}
	return levels
}

/** Parse DESTROYER_MIN_JOIN_RATE (0 < rate <= 1); defaults to 0.9. */
export function destroyerMinJoinRate(env = process.env) {
	const rate = Number(env.DESTROYER_MIN_JOIN_RATE ?? 0.9)
	if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
		throw new Error('DESTROYER_MIN_JOIN_RATE must be greater than 0 and at most 1')
	}
	return rate
}
