/**
 * Server-side session store for the identity cookie.
 *
 * The cookie carries only an opaque 128-bit base64url session-id. The
 * actual identity (id, name, color, org) lives in Redis under
 * `identity-session:<id>` as a hash. This is the canonical "cookie = key
 * into a server-side store" pattern; the cookie itself is unforgeable in
 * the meaningful sense (the only way to forge an identity is to guess a
 * 128-bit random id, which is computationally infeasible).
 *
 * Compared to the prior HMAC-signed-payload form this gives us:
 *
 *   - Trivial revocation: `DEL identity-session:<id>` invalidates one
 *     user. The HMAC pattern had no per-user revocation - any cookie
 *     signed with the still-current secret stayed valid.
 *   - Trivial mutation: `HSET identity-session:<id> org globex` flips
 *     a field server-side. No re-sign, no replica sync.
 *   - No long-lived shared secret to leak, rotate, or distribute across
 *     replicas. Compromise of the Redis access path is a separate (and
 *     bigger) failure mode that the HMAC pattern did not defend against
 *     anyway.
 *
 * Sessions expire after 30 days of inactivity (TTL refreshed on every
 * read). Cookie maxAge mirrors the TTL.
 *
 * @module identity-session
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { generateIdentity } from '$lib/names'

const SESSION_TTL_SEC = 60 * 60 * 24 * 30
export const SESSION_COOKIE_MAX_AGE = SESSION_TTL_SEC
const KEY_PREFIX = 'identity-session:'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/i
const VALID_ORGS = new Set(['acme', 'globex'])
// 22 chars base64url = 16 bytes = 128 bits. Matches what randomBytes(16).toString('base64url') emits.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/

function fullKey(sessionId) {
	return redis.key(KEY_PREFIX + sessionId)
}

function newSessionId() {
	return randomBytes(16).toString('base64url')
}

/** Strict-validate a Redis hash payload into the identity shape the app expects. */
function validate(hash) {
	if (!hash || typeof hash !== 'object') return null
	if (typeof hash.id !== 'string' || !UUID_RE.test(hash.id)) return null
	if (typeof hash.name !== 'string' || hash.name.length < 1 || hash.name.length > 40) return null
	if (typeof hash.color !== 'string' || !HEX_COLOR_RE.test(hash.color)) return null
	const org = VALID_ORGS.has(hash.org) ? hash.org : null
	return { id: hash.id, name: hash.name, color: hash.color, org }
}

/**
 * Look up an existing session by id. Refreshes the TTL on a hit so active
 * sessions roll their expiry forward. Returns null on miss, malformed id,
 * or Redis breaker-tripped.
 *
 * @param {string | undefined | null} sessionId
 * @returns {Promise<{ id: string, name: string, color: string, org: string | null } | null>}
 */
export async function lookupSession(sessionId) {
	if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
	try {
		const hash = await redis.redis.hgetall(fullKey(sessionId))
		if (!hash || Object.keys(hash).length === 0) return null
		const identity = validate(hash)
		if (!identity) return null
		// Sliding-window TTL: every read pushes expiry 30 days out. Idle
		// sessions decay; active sessions stay alive.
		redis.redis.expire(fullKey(sessionId), SESSION_TTL_SEC).catch(() => {})
		return identity
	} catch {
		return null
	}
}

/**
 * Create a fresh session. The session-id is the value the caller writes
 * back to the cookie; the identity is what the page renders.
 *
 * `overrides` carries any already-known fields (e.g. when migrating a
 * legacy plain-JSON cookie's contents into a fresh session). Missing
 * fields are generated.
 *
 * @param {{ id?: string, name?: string, color?: string, org?: string } | null} [overrides]
 * @returns {Promise<{ sessionId: string, identity: { id: string, name: string, color: string, org: string } }>}
 */
export async function createSession(overrides) {
	const generated = generateIdentity()
	const id = overrides?.id ?? randomUUID()
	const name = overrides?.name ?? generated.name
	const color = overrides?.color ?? generated.color
	const org = VALID_ORGS.has(overrides?.org) ? overrides.org : 'acme'

	const sessionId = newSessionId()
	const hash = { id, name, color, org }
	try {
		await redis.redis.hset(fullKey(sessionId), hash)
		await redis.redis.expire(fullKey(sessionId), SESSION_TTL_SEC)
	} catch {
		// Redis breaker tripped - return the identity anyway so the page
		// can still render. The session will not persist; the next request
		// will mint another. Acceptable for a demo: no real auth is gated.
	}
	return { sessionId, identity: { id, name, color, org } }
}

/**
 * Mutate a single field on an existing session. Returns true on success,
 * false if the session does not exist or Redis is unreachable.
 *
 * @param {string} sessionId
 * @param {string} field
 * @param {string} value
 * @returns {Promise<boolean>}
 */
export async function updateSessionField(sessionId, field, value) {
	if (!sessionId || !SESSION_ID_RE.test(sessionId)) return false
	try {
		const key = fullKey(sessionId)
		// Refuse to write a field onto a non-existent session - avoids
		// resurrecting an expired session under the same id.
		const exists = await redis.redis.exists(key)
		if (!exists) return false
		await redis.redis.hset(key, field, value)
		await redis.redis.expire(key, SESSION_TTL_SEC)
		return true
	} catch {
		return false
	}
}

/**
 * Attempt to migrate a legacy plain-JSON identity cookie. Returns the
 * parsed identity if the cookie value is a valid pre-this-change shape,
 * null otherwise. Callers should mint a fresh session populated with
 * these fields so existing visitors don't lose their displayed name.
 *
 * @param {string | undefined | null} raw
 * @returns {{ id: string, name: string, color: string, org: string } | null}
 */
export function tryParseLegacyJsonCookie(raw) {
	if (!raw || typeof raw !== 'string') return null
	// Legacy cookies are JSON; new session-ids match SESSION_ID_RE. The
	// session-id form does not start with `{`, so cheap shape check first.
	if (raw[0] !== '{') return null
	try {
		const obj = JSON.parse(raw)
		if (!obj || typeof obj !== 'object') return null
		if (typeof obj.id !== 'string' || !UUID_RE.test(obj.id)) return null
		if (typeof obj.name !== 'string' || obj.name.length < 1 || obj.name.length > 40) return null
		if (typeof obj.color !== 'string' || !HEX_COLOR_RE.test(obj.color)) return null
		const org = VALID_ORGS.has(obj.org) ? obj.org : 'acme'
		return { id: obj.id, name: obj.name, color: obj.color, org }
	} catch {
		return null
	}
}

/** True if the cookie value looks like a session-id (vs legacy JSON or garbage). */
export function looksLikeSessionId(raw) {
	return typeof raw === 'string' && SESSION_ID_RE.test(raw)
}
