const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Parse and safety-check an E2E target. Remote targets require a deliberate
 * opt-in so a missing environment variable can never point the suite at the
 * public demo.
 */
export function assertSafeE2ETarget(raw, env = process.env) {
	let url
	try {
		url = new URL(raw)
	} catch {
		throw new Error(`Invalid E2E target URL: ${raw}`)
	}

	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`Unsupported E2E target protocol: ${url.protocol}`)
	}

	if (!LOOPBACK_HOSTS.has(url.hostname) && env.ALLOW_REMOTE_E2E !== '1') {
		throw new Error(
			`Refusing remote E2E target ${url.origin}. ` +
			'Set ALLOW_REMOTE_E2E=1 only after confirming the target is safe for test data.'
		)
	}

	return url
}

/** Resolve the Playwright HTTP base URL, defaulting to loopback. */
export function resolveE2EBaseURL(env = process.env) {
	const url = assertSafeE2ETarget(env.BASE_URL?.trim() || DEFAULT_BASE_URL, env)
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`BASE_URL must use http or https, got ${url.protocol}`)
	}
	return url.href.replace(/\/$/, '')
}

/** Convert an HTTP(S) test target into a WebSocket endpoint. */
export function toWebSocketURL(baseURL, pathname = '/ws', env = process.env) {
	const url = assertSafeE2ETarget(baseURL, env)
	if (url.protocol === 'http:') url.protocol = 'ws:'
	else if (url.protocol === 'https:') url.protocol = 'wss:'
	else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
		throw new Error(`Cannot convert ${url.protocol} to a WebSocket target`)
	}
	url.pathname = pathname
	url.search = ''
	url.hash = ''
	return url.href
}

/**
 * Handshake `Origin` for a node-side WebSocket client aimed at `wsURL`.
 *
 * A browser stamps this header itself; the `ws` package sends none unless
 * told to, and a handshake without one is refused wherever the server has a
 * canonical origin configured. Deriving it from the target rather than from
 * configuration is what keeps one load generator correct against a local
 * instance and against a deployment without being told which it is talking
 * to: the value always matches the host it is actually connecting to.
 *
 * @param {string} wsURL - a ws:// or wss:// endpoint
 * @returns {string} the matching http(s) origin
 */
export function toHandshakeOrigin(wsURL, env = process.env) {
	const url = assertSafeE2ETarget(wsURL, env)
	if (url.protocol === 'ws:') url.protocol = 'http:'
	else if (url.protocol === 'wss:') url.protocol = 'https:'
	return url.origin
}

export { DEFAULT_BASE_URL }
