import { createCircuitBreaker } from 'svelte-adapter-uws-extensions/breaker'

const BREAKER_OPTIONS = {
	failureThreshold: 5,
	resetTimeout: 30000
}

export function createRealtimeBreaker() {
	return createCircuitBreaker({
		...BREAKER_OPTIONS,
		onStateChange: (from, to) => console.log(`[redis breaker] ${from} -> ${to}`)
	})
}

export function createSessionBreaker() {
	return createCircuitBreaker(BREAKER_OPTIONS)
}

export const realtimeBreaker = createRealtimeBreaker()
export const sessionBreaker = createSessionBreaker()
