import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { createRedisClient } from 'svelte-adapter-uws-extensions/redis'
import { readControl, writeControl } from '../../src/lib/server/versioned-control.js'

test.skip(process.env.LOCAL_E2E !== '1', 'requires the local harness Redis')
let redis
let client
const keys = ['speed', 'bias']
test.beforeAll(() => {
	const url = process.env.REDIS_URL
	if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('requires loopback REDIS_URL')
	redis = createRedisClient({ url, autoShutdown: false, options: { keyPrefix: 'test:controls:' + randomUUID() + ':' } })
	client = redis.redis
})
test.afterAll(async () => {
	await client?.del(...keys.flatMap((key) => [key, key + ':revision']))
	await redis?.quit()
})

test('atomic writes and reads pair values with exact independent revisions', async () => {
	expect(await readControl(client, 'speed')).toEqual({ value: null, revision: '0' })
	await client.set('speed', 'legacy')
	expect(await readControl(client, 'speed')).toEqual({ value: 'legacy', revision: '0' })
	const written = new Map([['0', 'legacy']])
	const reads = []
	await Promise.all(Array.from({ length: 24 }, async (_, n) => {
		const value = String(n)
		const revision = await writeControl(client, 'speed', value)
		written.set(revision, value)
		reads.push(await readControl(client, 'speed'))
	}))
	expect(written.size).toBe(25)
	for (const pair of reads) expect(pair.value).toBe(written.get(pair.revision))
	expect((await readControl(client, 'speed')).revision).toBe('24')
	expect(await writeControl(client, 'bias', 'hot')).toBe('1')
	expect(await readControl(client, 'bias')).toEqual({ value: 'hot', revision: '1' })
	await client.set('speed:revision', '9007199254740992')
	expect(await writeControl(client, 'speed', 'precise')).toBe('9007199254740993')
	expect(await readControl(client, 'speed')).toEqual({ value: 'precise', revision: '9007199254740993' })
	await client.set('speed:revision', 'invalid')
	await expect(writeControl(client, 'speed', 'must-not-land')).rejects.toThrow()
	expect(await client.get('speed')).toBe('precise')
})
