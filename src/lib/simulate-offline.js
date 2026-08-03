// In-page "simulate offline" so a demo can tell its connection story
// without DevTools. There is no public client API to pause the socket,
// so this leans on two mechanisms the adapter client already supports:
//
//  1. The client drops its live socket on the browser `offline` event
//     and reconnects on `online` (that drop is exactly what arms the
//     realtime offline queue). We dispatch those events by hand.
//  2. To STAY offline until asked to recover (the queue drains on any
//     successful reconnect), we temporarily swap `window.WebSocket` for
//     a stub that never opens, so the client's reconnect attempts keep
//     failing. The client's `maxReconnectAttempts` default is Infinity,
//     so a blocked reconnect loop can never wedge into a terminal
//     failed state; the backoff just grows until we restore the real
//     socket and dispatch `online`, which resets the backoff and
//     reconnects immediately.
//
// This is a demo affordance to make connection stories visible in-page.
// A first-class client-side "simulate offline" primitive would be the
// proper home for it; until then this stays scoped to the demo pages
// that import it.
import { browser } from '$app/environment'

let realWebSocket = null

export function installOfflineBlock() {
	if (!browser || realWebSocket) return
	const Real = window.WebSocket
	realWebSocket = Real
	window.WebSocket = class OfflineSocket {
		static CONNECTING = Real.CONNECTING
		static OPEN = Real.OPEN
		static CLOSING = Real.CLOSING
		static CLOSED = Real.CLOSED
		constructor() {
			this.readyState = Real.CONNECTING
			this.binaryType = 'arraybuffer'
			this.onopen = null
			this.onclose = null
			this.onmessage = null
			this.onerror = null
			// Never reach OPEN. Fail on the next tick so the client sees a
			// normal transient (1006) drop, classifies it RETRY, and keeps
			// any offline queue armed while it schedules the next attempt.
			setTimeout(() => {
				this.readyState = Real.CLOSED
				this.onclose?.({ code: 1006, reason: 'simulated offline', wasClean: false })
			}, 0)
		}
		send() {}
		close() { this.readyState = Real.CLOSED }
		addEventListener() {}
		removeEventListener() {}
	}
}

export function removeOfflineBlock() {
	if (!browser || !realWebSocket) return
	window.WebSocket = realWebSocket
	realWebSocket = null
}

export function goOffline() {
	if (!browser) return
	installOfflineBlock()
	window.dispatchEvent(new Event('offline'))
}

export function goOnline() {
	if (!browser) return
	removeOfflineBlock()
	window.dispatchEvent(new Event('online'))
}

// For unmount guards: never leave the socket blocked when the page
// that blocked it goes away.
export function offlineBlockActive() {
	return realWebSocket !== null
}
