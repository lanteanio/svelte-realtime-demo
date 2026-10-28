const connections = ['slow-2g', '2g', '3g', '4g']

export function fieldPerformanceDevice(navigator, window) {
	if (!window.matchMedia('(pointer: coarse)').matches) return 'desktop'
	if (window.innerWidth <= 768) return 'mobile'
	if (window.innerWidth <= 1024) return 'tablet'
	return 'unknown'
}

export function fieldPerformanceConnection(navigator) {
	const effectiveType = navigator.connection?.effectiveType
	return connections.includes(effectiveType) ? effectiveType : 'unknown'
}

export function collectFieldPerformance(window, endpoint = '/api/field-performance') {
	const { document, navigator } = window
	const observers = []
	let lcp = null
	let inp = null
	let cls = 0
	let sawInteraction = false
	let sent = false
	const supported = { lcp: false, inp: false, cls: false }

	function observe(name, type, options, callback) {
		try {
			const observer = new window.PerformanceObserver(list => {
				for (const entry of list.getEntries()) callback(entry)
			})
			observer.observe({ type, ...options })
			observers.push(observer)
			supported[name] = true
		} catch {}
	}

	observe('lcp', 'largest-contentful-paint', { buffered: true }, entry => {
		lcp = entry.startTime
	})
	observe('cls', 'layout-shift', { buffered: true }, entry => {
		if (!entry.hadRecentInput) cls += entry.value
	})
	observe('inp', 'event', { buffered: true, durationThreshold: 40 }, entry => {
		if (!entry.interactionId) return
		sawInteraction = true
		inp = Math.max(inp ?? 0, entry.duration)
	})

	function send(event) {
		if (sent || (event?.type !== 'pagehide' && document.visibilityState !== 'hidden')) return
		sent = true
		const sample = {
			schemaVersion: 1,
			device: fieldPerformanceDevice(navigator, window),
			connection: fieldPerformanceConnection(navigator),
			metrics: {
				lcp: { eligible: supported.lcp, value: lcp === null ? null : Math.round(lcp) },
				inp: { eligible: supported.inp && sawInteraction, value: inp === null ? null : Math.round(inp) },
				cls: { eligible: supported.cls, value: supported.cls ? Math.round(cls * 1000) / 1000 : null }
			}
		}
		const body = JSON.stringify(sample)
		if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) return
		void window.fetch(endpoint, {
			method: 'POST', body, keepalive: true,
			headers: { 'content-type': 'application/json' }
		}).catch(() => {})
	}

	window.addEventListener('pagehide', send)
	document.addEventListener('visibilitychange', send)
	return () => {
		window.removeEventListener('pagehide', send)
		document.removeEventListener('visibilitychange', send)
		for (const observer of observers) observer.disconnect()
	}
}
