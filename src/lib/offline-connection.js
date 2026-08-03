/**
 * What the offline demo's status card is allowed to claim.
 *
 * The card used to branch on the in-page simulation toggle alone, so under
 * a genuine network loss it kept reporting "Connected." during precisely
 * the scenario the demo exists to show. Reading the real connection status
 * fixes that, but naively - `up` versus `not up` - introduces the opposite
 * lie: the first moments of every page load are 'connecting', which is
 * neither. Folding that into "offline" raises an amber alarm about nothing
 * on every single visit, on a page whose subject is trusting this readout.
 *
 * Hence four states, and a module rather than an inline ternary: the
 * connecting window is a startup state, and a startup state cannot be
 * oracled by a browser test against a long-lived server (the same reason
 * the ops reading rules live in $lib/ops-readings). Here it is a pure
 * function with unit coverage, where the mistake above fails a test.
 */

/**
 * @param {string} status adapter connection status
 * @param {boolean} simulatedOffline in-page "Go offline" toggle
 * @returns {'simulated' | 'online' | 'connecting' | 'down'}
 */
export function connectionState(status, simulatedOffline) {
	// The simulation is a deliberate act by the visitor and outranks the
	// socket's own state, which is a consequence of it.
	if (simulatedOffline) return 'simulated'
	// 'suspended' is a live socket on a backgrounded tab.
	if (status === 'open' || status === 'suspended') return 'online'
	if (status === 'connecting') return 'connecting'
	return 'down'
}

/** True when queued work is waiting on something, rather than draining. */
export function isOffline(state) {
	return state === 'simulated' || state === 'down'
}
