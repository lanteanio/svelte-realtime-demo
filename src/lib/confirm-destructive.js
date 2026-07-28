const SHARED_STATE_WARNING = 'This changes shared demo state for everyone and cannot be undone.'

/**
 * One confirmation gate for public-demo actions that erase shared state.
 * Keep the warning and button dress consistent across every demo surface.
 */
export function confirmDestructive(action) {
	return window.confirm(`${action}\n\n${SHARED_STATE_WARNING}`)
}
