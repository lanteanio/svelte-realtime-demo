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
