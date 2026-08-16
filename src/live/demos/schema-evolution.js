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

/**
 * The increment and its timestamp, from one ordering.
 *
 * Taking `Date.now()` in the handler and HINCRBY over the wire puts the value
 * and the stamp on two independent orderings: a replica that reads its clock
 * early and lands late writes the HIGHER value under the EARLIER time, so the
 * pair the page displays is not a fact about any single moment. Two replicas
 * make it worse than a reordering, because their wall clocks are not the same
 * clock at all and the stamps are not comparable.
 *
 * Redis is the one thing both replicas share, so both halves come from it:
 * `TIME` inside the script is read between the increment and the write, and
 * the script is atomic, so the value and the stamp are one observation. That
 * also means every timestamp on this page comes from a single clock however
 * many replicas are serving it.
 *
 * Redis has permitted a write after a non-deterministic read since script
 * effects replication became the default in 5.0; this deployment is on 7.
 */
const INCREMENT_SCRIPT = `
local value = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('HSET', KEYS[2], ARGV[1], tostring(ms))
return { value, ms }
`

/** The same single clock for the reset, which stamps every counter at once. */
const RESET_SCRIPT = `
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
for i = 1, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], 0)
  redis.call('HSET', KEYS[2], ARGV[i], tostring(ms))
end
return ms
`

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

/**
 * A worked example of the migration, produced by the REAL `v1ToV2`.
 *
 * Both panels render identical rows - same labels, same values, same dot
 * colours - so the only visible difference was a badge, and the visitor was
 * asked to believe a migration ran without ever seeing what it transformed.
 * Running the actual function over an actual v1-shaped row is what makes that
 * a demonstration rather than a claim, and it cannot drift from the code: if
 * `v1ToV2` changes, this changes with it.
 */
const V1_SAMPLE = { id: SEED_IDS[0], value: 3 }

export const myCounterState = live(async () => ({
	serverVersion: 2,
	seedIds: SEED_IDS,
	migrateSource: STREAM_REGISTRATION_SNIPPET,
	migrateSample: { before: V1_SAMPLE, after: v1ToV2(V1_SAMPLE) }
}))

export const incrementCounter = live(async (ctx, id) => {
	if (typeof id !== 'string' || !SEED_IDS.includes(id)) {
		throw new LiveError('VALIDATION', 'unknown counter')
	}
	// HINCRBY is atomic per field, so two concurrent increments from
	// different replicas never lose a count. The timestamp goes into a
	// parallel hash because HINCRBY only works on integer values, and into
	// the same script so it is the same observation as the value.
	const [value, modifiedAt] = await redis.redis.eval(INCREMENT_SCRIPT, 2, VALUES_KEY, TIMES_KEY, id)
	const payload = v2Shape({ id, value, modifiedAt })
	ctx.publish(TOPICS.demoSchemaCounter, 'updated', payload)
	return payload
})

export const resetCounters = live(async (ctx) => {
	const modifiedAt = await redis.redis.eval(RESET_SCRIPT, 2, VALUES_KEY, TIMES_KEY, ...SEED_IDS)
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
