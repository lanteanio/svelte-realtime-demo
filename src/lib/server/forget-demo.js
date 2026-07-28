import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

/**
 * Shared result cache for the Forget demo's draft RPC. The same store is
 * passed to live.idempotent and to createForgetStore, so a retry on another
 * replica deduplicates and live.forget can purge the result cluster-wide.
 */
export const forgetDraftIdempotency = createIdempotencyStore(redis, {
	keyPrefix: 'demos:forget:idemp:',
	ttl: 300,
	acquireTtl: 30,
	breaker,
	metrics
})
