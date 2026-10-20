import { defineEnvVars } from '@sveltejs/kit/env'

// Keep runtime values optional so local development can use its fallbacks.
export const variables = defineEnvVars({
	DATABASE_URL: { schema: (value) => value },
	REDIS_URL: { schema: (value) => value },
	DEMO_PURGE_INTERVAL_MIN: { schema: (value) => value },
	DEMO_UPLOAD_PURGE_INTERVAL_MIN: { schema: (value) => value }
})
