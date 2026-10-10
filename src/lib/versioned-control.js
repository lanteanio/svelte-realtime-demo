/**
 * Subscribe to a versioned control and reconcile each notification with its
 * authoritative snapshot. A set-merge stream notifies once per animation
 * frame, so a newer publish followed by an older one can hide the newer value.
 * Serialized reads recover it, including on initial load and reconnect. A
 * notification during a read discards that reply and requests a fresh snapshot.
 * A settled snapshot rebases the revision even after Redis resets its counter.
 */
export function subscribeControl(stream, read, receive) {
	let active = true
	let reading = false
	let dirty = false
	let revision = -1n

	function accept(value, authoritative = false) {
		if (!active || typeof value?.revision !== 'string' || !/^\d+$/.test(value.revision)) return
		const next = BigInt(value.revision)
		if (!authoritative && next < revision) return
		revision = next
		receive(value)
	}

	async function reconcile() {
		if (reading) return
		reading = true
		try {
			do {
				dirty = false
				try {
					const snapshot = await read()
					// A notification during this read may follow the Redis read.
					// Discard the reply and repeat before treating it as authoritative.
					if (!dirty) accept(snapshot, true)
				} catch {
					// Failed reconciliation retries on the next notification,
					// including the initial snapshot after reconnect.
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
