/**
 * Guards for extension calls made from inside the synchronous WebSocket
 * hooks in hooks.ws.js.
 *
 * The adapter attaches a rejection handler to a promise that a hook RETURNS,
 * but these calls run inside the demo's own hooks, so nothing upstream sees
 * their promises. An unobserved rejection ends the process under Node's
 * default policy, taking every other connection on the replica with it.
 */

const WARN_INTERVAL_MS = 5000
const MAX_WARN_KEYS = 256

const warnedAt = new Map()

function report(label, error) {
	// A socket that closes while a presence join awaits Redis makes the join
	// reject with WS_CLOSED after the extension has rolled it back. That is an
	// ordinary disconnect, so it is not logged.
	if (error?.code === 'WS_CLOSED') return
	// Keyed by label and error kind so a frequent failure on one hook does not
	// hide a different failure on the same hook.
	const key = `${label}:${error?.code ?? error?.name}`
	const now = Date.now()
	if (now - (warnedAt.get(key) ?? 0) < WARN_INTERVAL_MS) return
	if (warnedAt.size >= MAX_WARN_KEYS) warnedAt.clear()
	warnedAt.set(key, now)
	console.warn(`[realtime] ${label} degraded`, {
		name: error?.name,
		code: error?.code
	})
}

/**
 * Run an extension call whose result nothing else observes. A returned
 * thenable gets a rejection handler and a synchronous throw is caught; both
 * go to `report`. A call that returns a plain value gets no promise handling.
 *
 * @param {string} label
 * @param {() => unknown} operation
 */
export function bestEffort(label, operation) {
	try {
		const result = operation()
		if (result != null && typeof result.then === 'function') {
			result.then(undefined, (error) => report(label, error))
		}
	} catch (error) {
		report(label, error)
	}
}

/**
 * Route a parsed non-RPC frame to the cursor and presence plugins.
 *
 * Every frame except a cursor snapshot request goes to cursor.hooks.message
 * directly, which keeps cursor position frames (pointer rate) on the shortest
 * path; the hook ignores types it does not own. A `cursor-snapshot` request
 * reads Redis, and
 * cursor.hooks.message starts that read without returning its promise, so the
 * request goes through cursor.snapshot here instead, where a rejection is
 * observed. presence.hooks.message attaches its own handler to its snapshot
 * read and ignores frame types it does not own.
 *
 * @param {any} ws
 * @param {{ type?: unknown, topic?: unknown }} parsed
 * @param {any} platform
 * @param {any} cursor
 * @param {any} presence
 */
export function forwardPluginFrame(ws, parsed, platform, cursor, presence) {
	if (parsed.type === 'cursor-snapshot') {
		if (typeof parsed.topic === 'string') {
			bestEffort('cursor snapshot', () => cursor.snapshot(ws, parsed.topic, platform))
		}
	} else {
		cursor.hooks.message(ws, { data: parsed, platform })
	}
	presence.hooks.message(ws, { data: parsed, platform })
}
