const OBSERVED = Symbol('redis-command-rejections-observed')

/**
 * Attach a terminal observer to every ioredis command Promise.
 *
 * Awaiting callers still receive the original rejected Promise unchanged.
 * The extra branch only prevents a third-party timer or reconnect path that
 * accidentally drops its Promise from becoming a process-fatal unhandled
 * rejection during an ordinary Redis outage.
 */
export function observeRedisCommandRejections(client) {
	if (!client || client[OBSERVED] || typeof client.sendCommand !== 'function') return client
	const sendCommand = client.sendCommand
	client.sendCommand = function (...args) {
		const pending = sendCommand.apply(this, args)
		if (pending && typeof pending.catch === 'function') pending.catch(() => {})
		return pending
	}
	Object.defineProperty(client, OBSERVED, { value: true })
	return client
}
