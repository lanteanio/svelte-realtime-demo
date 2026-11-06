/**
 * The adapter subscribe hooks realtime() builds around the app's gates.
 *
 * The gates run only inside these hooks. A svelte-realtime that predates
 * them returns neither, and an adapter without subscribe hooks admits
 * every subscribe, so a missing hook stops the server at startup instead
 * of serving with the gates gone.
 *
 * @param {{ subscribe?: unknown, subscribeBatch?: unknown } | null | undefined} config
 * @returns {{ subscribe: Function, subscribeBatch: Function }}
 */
export function requireSubscribeHooks(config) {
	const subscribe = config?.subscribe
	const subscribeBatch = config?.subscribeBatch
	if (typeof subscribe !== 'function' || typeof subscribeBatch !== 'function') {
		throw new Error(
			'svelte-realtime returned no subscribe hooks for the app gates, so every subscribe would be admitted. ' +
			'Install the locked dependencies (npm ci) or update svelte-realtime to 0.6.0-next.92 or later.'
		)
	}
	return { subscribe, subscribeBatch }
}
