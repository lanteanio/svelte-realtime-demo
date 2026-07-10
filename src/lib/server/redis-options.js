/** Bounds for every Redis command, including commands queued while reconnecting. */
export const REDIS_CONNECT_TIMEOUT_MS = 1500
export const REDIS_COMMAND_TIMEOUT_MS = 2000
export const REDIS_MAX_RETRIES_PER_REQUEST = 1
export const REDIS_RETRY_MAX_DELAY_MS = 2000

/** Shared ioredis options. Kept pure so the failure bounds are unit-testable. */
export function redisConnectionOptions() {
	return {
		lazyConnect: true,
		enableReadyCheck: true,
		enableOfflineQueue: true,
		connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
		commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
		maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
		retryStrategy(attempt) {
			return Math.min(Math.max(1, attempt) * 200, REDIS_RETRY_MAX_DELAY_MS)
		}
	}
}
