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

export { DEFAULT_BASE_URL }
