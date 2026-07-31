const SHARED_STATE_WARNING = 'This changes shared demo state for everyone and cannot be undone.'
const UNDOABLE_STATE_WARNING = 'This changes shared demo state for everyone. You can undo it for a few seconds.'

/**
 * One confirmation gate for public-demo actions that erase shared state.
 * Keep the warning and button dress consistent across every demo surface.
 *
 * `undoable` picks the wording for the rare action that really does offer an
 * undo afterwards. The default promises the change cannot be taken back, and a
 * gate that says so in front of a reversible action teaches visitors to
 * discount the warning on the surfaces where it is literally true.
 */
export function confirmDestructive(action, { undoable = false } = {}) {
	return window.confirm(`${action}\n\n${undoable ? UNDOABLE_STATE_WARNING : SHARED_STATE_WARNING}`)
}
