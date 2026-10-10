const WRITE = `
redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1])
return redis.call('GET', KEYS[2])
`

// Keep the decimal revision as a string: Redis counters can exceed JS's
// exact integer range. The value and revision must share one Redis operation.
export async function writeControl(client, key, value) {
	return client.eval(WRITE, 2, key, key + ':revision', String(value))
}

export async function readControl(client, key) {
	const [value, revision] = await client.mget(key, key + ':revision')
	return { value, revision: revision ?? '0' }
}
