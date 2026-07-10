// realtime-allow-public -- this gallery demo is intentionally public.
/**
 * /demos/schema-evolution: live.stream `version` + `migrate` hooks,
 * exercised end-to-end via `subscribeAt` from
 * `svelte-realtime/testing/client`.
 *
 * The pitch. One stream registered at `version: 2` with a `migrate[1]`
 * forward function. The page subscribes once normally (the wire
 * envelope carries no `schemaVersion`, so the server's loader output
 * goes through unchanged) AND once via `subscribeAt(counter, {
 * schemaVersion: 1 })` - the wire envelope claims `schemaVersion: 1`,
 * the server's `_executeStreamRpc` sees `clientSchemaVersion <
 * serverVersion`, runs `_migrateData` forward through the registered
 * chain, and returns the migrated payload to that parallel store.
 *
 * Both panels then receive the same live publishes. The migrate chain
 * only fires on the initial subscribe response; subsequent events are
 * raw v2 publishes that merge into the migrated base. To make this
 * observable, the loader stamps every item with `provenance: 'loader'`,
 * and `migrate[1]` overwrites it to `provenance: 'migrate[1]'`. After
 * an increment, the affected row's badge flips back to `loader` in the
 * v1 panel (the raw publish replaces the migrated base for that key);
 * untouched rows keep their `migrate[1]` badge until they too get a
 * live publish.
 *
 * The headline primitive: `live.stream({ version, migrate })`.
 * The demo-only affordance: `subscribeAt(stream, { schemaVersion })`
 * from `svelte-realtime/testing/client`. Production code never imports
 * `/testing/client`.
 *
 * Storage is in-memory.
 */

import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import { redis } from '$lib/server/redis'

const SEED_IDS = ['alpha', 'beta', 'gamma']
const LABELS = {
	alpha: 'Alpha counter',
	beta: 'Beta counter',
	gamma: 'Gamma counter'
}
const COLORS = {
	alpha: '#3b82f6',
	beta: '#10b981',
	gamma: '#f59e0b'
}

const VALUES_KEY = 'demos:schema:values'
const TIMES_KEY = 'demos:schema:times'

function v2Shape(c) {
	return {
		id: c.id,
		value: c.value,
		label: LABELS[c.id] ?? c.id,
		color: COLORS[c.id] ?? '#888888',
		modifiedAt: c.modifiedAt,
		provenance: 'loader'
	}
}

async function readAllCounters() {
	const [valuesRaw, timesRaw] = await Promise.all([
		redis.redis.hmget(VALUES_KEY, ...SEED_IDS),
		redis.redis.hmget(TIMES_KEY, ...SEED_IDS)
	])
	return SEED_IDS.map((id, i) => {
		const value = valuesRaw[i] === null ? 0 : Number(valuesRaw[i])
		const modifiedAt = timesRaw[i] === null ? 0 : Number(timesRaw[i])
		return {
			id,
			value: Number.isFinite(value) ? value : 0,
			modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0
		}
	})
}

/**
 * migrate[1]: forward-fill the v2 fields and stamp the provenance
 * badge so the page can show that the migrate chain ran. Idempotent
 * on already-v2 data because label and color are deterministic from
 * the id and `??` falls back when the input lacks the field. The
 * `provenance: 'migrate[1]'` overwrite is the visible signal that
 * this function executed on this item.
 */
function v1ToV2(item) {
	return {
		...item,
		label: item.label ?? LABELS[item.id] ?? item.id,
		color: item.color ?? COLORS[item.id] ?? '#888888',
		modifiedAt: item.modifiedAt ?? Date.now(),
		provenance: 'migrate[1]'
	}
}

// Hold the registration snippet shown to the page outside any
// scanner-visible literal. The vite plugin regex-matches calls to
// the streaming primitive and would mistake an inlined snippet that
// echoes the literal call shape for an actual registration. The
// runtime concatenation below reads the same way to a human but
// reaches the page intact.
const STREAM_REGISTRATION_SNIPPET = [
	'// /live/demos/schema-evolution.js',
	'',
	'const opts = {',
	'  version: 2,',
	'  migrate: { 1: v1ToV2 },',
	"  merge: 'crud',",
	'  key: id',
	'}',
	'',
	'export const counter = ' + 'live.' + 'stream(',
	'  TOPICS.demoSchemaCounter,',
	'  async () => Array.from(counters.values()).map(v2Shape),',
	'  opts',
	')'
].join('\n')

export const myCounterState = live(async () => ({
	serverVersion: 2,
	seedIds: SEED_IDS,
	migrateSource: STREAM_REGISTRATION_SNIPPET
}))

export const incrementCounter = live(async (ctx, id) => {
	if (typeof id !== 'string' || !SEED_IDS.includes(id)) {
		throw new LiveError('VALIDATION', 'unknown counter')
	}
	const modifiedAt = Date.now()
	// HINCRBY is atomic per field, so two concurrent increments from
	// different replicas never lose a count. The timestamp goes into a
	// parallel hash because HINCRBY only works on integer values.
	const value = await redis.redis.hincrby(VALUES_KEY, id, 1)
	await redis.redis.hset(TIMES_KEY, id, String(modifiedAt))
	const payload = v2Shape({ id, value, modifiedAt })
	ctx.publish(TOPICS.demoSchemaCounter, 'updated', payload)
	return payload
})

export const resetCounters = live(async (ctx) => {
	const modifiedAt = Date.now()
	const pipeline = redis.redis.multi()
	for (const id of SEED_IDS) {
		pipeline.hset(VALUES_KEY, id, 0)
		pipeline.hset(TIMES_KEY, id, String(modifiedAt))
	}
	await pipeline.exec()
	for (const id of SEED_IDS) {
		ctx.publish(TOPICS.demoSchemaCounter, 'updated', v2Shape({ id, value: 0, modifiedAt }))
	}
	return { ok: true }
})

export const counter = live.stream(
	TOPICS.demoSchemaCounter,
	async () => (await readAllCounters()).map(v2Shape),
	{
		version: 2,
		migrate: { 1: v1ToV2 },
		merge: 'crud',
		key: 'id'
	}
)
