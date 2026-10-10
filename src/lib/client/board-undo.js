/** Leave text editing, redo, held keys and already-handled gestures alone. */
export function isBoardUndoShortcut(event) {
	if (event.defaultPrevented || event.repeat || event.shiftKey || event.altKey) return false
	if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return false
	const target = event.target
	return !target?.isContentEditable && !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}

/** Update only while an undo deadline is live, including its exact expiry. */
export function startUndoCountdown(deadlines, update) {
	const end = deadlines.reduce((latest, value) => Math.max(latest, value), 0)
	let timer
	function tick() {
		const now = Date.now()
		update(now)
		if (now < end) timer = setTimeout(tick, Math.min(250, end - now))
	}
	tick()
	return () => clearTimeout(timer)
}
