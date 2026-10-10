/**
 * Subscribe to a versioned control and reconcile each notification with its
 * authoritative snapshot. A set-merge stream notifies once per animation
 * frame, so a newer publish followed by an older one can hide the newer value.
 * One serialized read per notification burst recovers it; a dirty read loops
 * once more so changes arriving during the round trip cannot be lost.
 */
export function subscribeControl(stream, read, receive) {
	let active = true
	let reading = false
	let dirty = false
	let revision = -1n

	function accept(value) {
		if (!active || typeof value?.revision !== 'string' || !/^\d+$/.test(value.revision)) return
		const next = BigInt(value.revision)
		if (next < revision) return
		revision = next
		receive(value)
	}

	async function reconcile() {
		if (reading) return
		reading = true
		try {
			do {
				dirty = false
				try { accept(await read()) } catch {
					// A disconnected RPC cannot refresh state. The next stream
					// notification, including its reconnect snapshot, retries.
				}
			} while (active && dirty)
		} finally {
			reading = false
		}
	}

	const off = stream.subscribe((value) => {
		if (!active || value == null) return
		accept(value)
		dirty = true
		void reconcile()
	})
	return () => {
		active = false
		dirty = false
		off()
	}
}
