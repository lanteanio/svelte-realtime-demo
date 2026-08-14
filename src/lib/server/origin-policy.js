/**
 * What this deployment answers to.
 *
 * Two questions share one source of truth here, because answering them from
 * different places is how a deployment ends up accepting a WebSocket from a
 * hostname whose pages it refuses to serve.
 *
 * WEBSOCKET ADMISSION. Two layers decide it, and they cover different cases.
 * The adapter answers the first: a handshake carrying an `Origin` header is
 * compared against the deployment's configured origins and refused with a 403
 * before any application code runs. A browser cannot forge that header, so
 * this is what keeps a page served from somewhere else from opening a socket
 * here.
 *
 * This module answers the second: what to do when the handshake carries no
 * `Origin` at all. The adapter cannot decide that one for us - its check
 * returns "allowed" for an Origin-less request whenever an `upgrade` hook is
 * exported, meaning "the application has a hook, so let it authenticate this
 * client itself". Exporting a hook therefore converts an Origin-less
 * handshake into an unconditional pass unless the hook decides otherwise.
 *
 * Refusing one costs no real visitor a connection: browsers always send
 * `Origin` on a WebSocket handshake. It costs scripted non-browser clients,
 * which is the intent. The load generators in this repository send an
 * `Origin` derived from the URL they were pointed at, so they satisfy the
 * adapter's check on their own and never reach that branch.
 *
 * HTTP HOST. The same configured names decide which `Host` a request may
 * claim. Both variables feed it, which is the point of keeping them together:
 * a deployment reachable at an apex and a www name declares both in
 * `ALLOWED_ORIGINS`, and a host check reading only `ORIGIN` would serve the
 * first and refuse the second.
 *
 * The policy keys on whether an origin was DECLARED rather than on
 * `NODE_ENV`. A production build is run with `NODE_ENV=production` in several
 * places that are not public deployments - the local end-to-end tier builds
 * and runs exactly that way - so `NODE_ENV` does not separate "public
 * deployment" from "someone's laptop"; a declared origin does. A fresh clone
 * that declares nothing keeps the permissive behaviour, so `npm run dev` and
 * a bare self-hosted checkout work with no configuration.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Every origin this deployment declares, as a `URL`-normalized host set
 * (`example.com`, `example.com:8443`).
 *
 * An unparseable entry contributes nothing rather than throwing: one typo in
 * a comma-separated list must not take the whole site down, and the entries
 * that do parse still constrain what is accepted.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Set<string>}
 */
export function deploymentHosts(env) {
	const hosts = new Set()
	for (const value of [env.ORIGIN, ...(env.ALLOWED_ORIGINS || '').split(',')]) {
		const trimmed = (value || '').trim()
		if (!trimmed) continue
		try {
			hosts.add(new URL(trimmed).host)
		} catch {
			continue
		}
	}
	return hosts
}

/**
 * Accept a request's `Host` header against the declared set.
 *
 * Loopback names are always accepted: container health probes, the local
 * end-to-end tier and `npm run preview` address the server directly rather
 * than through any public name.
 *
 * Worth being honest about the ceiling. `Host` is trivially rewritten by
 * anything sitting in front of the server, and the common proxy default is to
 * send the upstream's own name, which passes this check unchanged. What it
 * catches is a front end that forwards the client's `Host` verbatim, which is
 * enough to make the document itself refuse to serve under a foreign name. It
 * raises the floor; it does not close the door.
 *
 * @param {string | null | undefined} hostHeader
 * @param {Set<string>} hosts - from `deploymentHosts`
 * @returns {boolean}
 */
export function isAcceptableHost(hostHeader, hosts) {
	if (hosts.size === 0) return true
	if (!hostHeader) return false
	if (hosts.has(hostHeader)) return true
	return LOOPBACK_NAMES.has(hostHeader.replace(/:\d+$/, '').toLowerCase())
}

/**
 * Read the upgrade-origin policy out of an environment bag.
 *
 * Either variable counts as declaring a public origin. `ORIGIN` is the usual
 * one; `ALLOWED_ORIGINS` is what a deployment reachable under several names
 * sets instead, and a deployment that named its hostnames has declared itself
 * just as much as one that named a single canonical origin. Only whether one
 * was declared matters here - the comparison against the value belongs to the
 * adapter, which has already done it by the time this runs.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ hasDeclaredOrigin: boolean, allowOriginless: boolean }}
 */
export function upgradeOriginPolicy(env) {
	return {
		hasDeclaredOrigin: deploymentHosts(env).size > 0,
		allowOriginless: env.WS_ALLOW_ORIGINLESS === '1'
	}
}

/**
 * Decide whether a handshake may proceed to session lookup.
 *
 * Returns a reason on both paths so the caller can log a refusal and label a
 * counter without restating the rules.
 *
 * @param {string | undefined} requestOrigin - the handshake's `Origin` header
 * @param {{ hasDeclaredOrigin: boolean, allowOriginless: boolean }} policy
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateUpgradeOrigin(requestOrigin, policy) {
	// A present Origin was already matched against the declared origins by the
	// adapter; anything that failed that comparison never gets here.
	if (requestOrigin) return { allowed: true, reason: 'origin_checked_by_adapter' }
	if (policy.allowOriginless) return { allowed: true, reason: 'originless_opt_in' }
	if (!policy.hasDeclaredOrigin) return { allowed: true, reason: 'no_declared_origin' }
	return { allowed: false, reason: 'originless_refused' }
}
