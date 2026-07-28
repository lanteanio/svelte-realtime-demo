/**
 * Server-side state for /demos/upload.
 *
 * Cluster-shared file index in Redis. Chunk dedup is content-addressed
 * via a per-replica `Set<hash>` - the demo's pitch is "two uploads with
 * the same hashes report dedup: true", which only needs the hash
 * existence check. We deliberately do NOT retain chunk bytes:
 * `live.upload` already streams bytes through the handler, the dedup
 * check fires inside the loop, and nothing downstream reads bytes back
 * (the wire surface returns metadata + dedupedChunks count only). An
 * earlier version stored `Uint8Array` chunks in this Map; under cluster
 * deploys where `purgeMemory` is leader-gated, non-leader workers
 * accumulated bytes forever - a real leak, not a "demo accepts it"
 * leak. The Set-of-hashes shape is bounded at ~MAX_FILES * avg-chunks-
 * per-file entries (~64 bytes each), measured in KB.
 *
 * Files are kept under MAX_FILE_BYTES total or MAX_FILES count, whichever
 * is smaller. Eviction drops the least-recently-uploaded file when over
 * capacity. Because ids are content-addressed, re-uploading a file is an
 * upsert that moves it back to the newest position rather than adding a
 * second entry - a re-upload is a fresh user action, so it should not be
 * the next thing evicted. The trade-off is that a re-upload can evict a
 * file that was uploaded after it.
 */

import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { env } from '$env/dynamic/private'
import { redis, breaker } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

export const MAX_FILES = 30
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const CHUNK_SIZE_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 1024 * 1024
export const MAX_FILENAME_LEN = 200

const FILES_KEY = 'demos:upload:files'         // HASH: id -> JSON record
const ORDER_KEY = 'demos:upload:order'         // LIST: ids by last upload, oldest first
const BYTES_KEY = 'demos:upload:bytes-total'   // counter: sum of totalBytes across surviving files

// Content-addressed file ids make a repeated upload an UPSERT, not a
// second logical file. Keep the hash record, one order entry, and the
// byte counter consistent in one Redis turn so concurrent replicas
// cannot both count the same id as new.
const UPSERT_FILE_SCRIPT = `
	local previous = redis.call('HGET', KEYS[1], ARGV[1])
	local oldBytes = 0
	if previous then
		local ok, decoded = pcall(cjson.decode, previous)
		if ok and type(decoded) == 'table' and type(decoded.totalBytes) == 'number' then
			oldBytes = decoded.totalBytes
		end
	end
	redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
	redis.call('LREM', KEYS[2], 0, ARGV[1])
	redis.call('RPUSH', KEYS[2], ARGV[1])
	local newBytes = tonumber(ARGV[3]) or 0
	local delta = newBytes - oldBytes
	if delta ~= 0 then
		redis.call('INCRBY', KEYS[3], delta)
	elseif redis.call('EXISTS', KEYS[3]) == 0 then
		redis.call('SET', KEYS[3], 0)
	end
	return previous and 1 or 0
`

// One eviction step: inspect the head, drop it from both the hash and the
// order list, and subtract its bytes in a single Redis turn. Reading the
// record and decrementing the counter as separate commands let two replicas
// both subtract the same file's bytes. Returns the evicted id, an empty
// string when the head is the caller's own just-appended record, or nil when
// the list is empty.
const EVICT_OLDEST_SCRIPT = `
	local oldest = redis.call('LINDEX', KEYS[2], 0)
	if not oldest then return nil end
	if oldest == ARGV[1] then return '' end
	redis.call('LPOP', KEYS[2])
	local raw = redis.call('HGET', KEYS[1], oldest)
	if raw then
		redis.call('HDEL', KEYS[1], oldest)
		local ok, decoded = pcall(cjson.decode, raw)
		if ok and type(decoded) == 'table' and type(decoded.totalBytes) == 'number' then
			redis.call('DECRBY', KEYS[3], decoded.totalBytes)
		end
	end
	if redis.call('HLEN', KEYS[1]) == 0 then
		redis.call('SET', KEYS[3], 0)
	else
		local total = tonumber(redis.call('GET', KEYS[3]) or '0')
		if total < 0 then redis.call('SET', KEYS[3], 0) end
	end
	return oldest
`

// Removal mirrors the upsert atomically. LREM count=0 also repairs order
// lists written by the old duplicate-append behavior; resetting an empty
// index to zero repairs its historical byte-counter drift.
const REMOVE_FILE_SCRIPT = `
	local raw = redis.call('HGET', KEYS[1], ARGV[1])
	if not raw then
		redis.call('LREM', KEYS[2], 0, ARGV[1])
		if redis.call('HLEN', KEYS[1]) == 0 then redis.call('SET', KEYS[3], 0) end
		return 0
	end
	local bytes = 0
	local ok, decoded = pcall(cjson.decode, raw)
	if ok and type(decoded) == 'table' and type(decoded.totalBytes) == 'number' then
		bytes = decoded.totalBytes
	end
	redis.call('HDEL', KEYS[1], ARGV[1])
	redis.call('LREM', KEYS[2], 0, ARGV[1])
	if bytes ~= 0 then redis.call('DECRBY', KEYS[3], bytes) end
	if redis.call('HLEN', KEYS[1]) == 0 then
		redis.call('SET', KEYS[3], 0)
	else
		local total = tonumber(redis.call('GET', KEYS[3]) or '0')
		if total < 0 then redis.call('SET', KEYS[3], 0) end
	end
	return 1
`

/**
 * Redis-backed idempotency cache for chunk storage. A retry on the
 * same chunk hash short-circuits to the cached result instead of
 * uploading bytes again. Keyed under the upload demo's prefix so it
 * does not collide with anything else if more demos ever wire the
 * idempotency store.
 *
 * Null when REDIS_URL is empty - the demo falls back to a plain
 * Map<hash, bytes> dedup test (still demonstrates content-addressed
 * dedup, just without the cluster-shared cache layer).
 */
export const chunkIdempotency = env.REDIS_URL
	? createIdempotencyStore(redis, {
			keyPrefix: 'demo-upload:chunk:',
			ttl: 60 * 60,
			acquireTtl: 30,
			breaker,
			metrics
		})
	: null

/** @type {Set<string>} hashes only - bytes never retained, see file docstring */
const chunks = new Set()

export function hasChunk(hash) {
	return chunks.has(hash)
}

export function storeChunk(hash) {
	if (chunks.has(hash)) return false
	chunks.add(hash)
	return true
}

export async function listFiles() {
	const ids = await redis.redis.lrange(ORDER_KEY, 0, -1)
	if (ids.length === 0) return []
	const raws = await redis.redis.hmget(FILES_KEY, ...ids)
	const out = []
	for (const raw of raws) {
		if (raw === null) continue
		try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
	}
	return out
}

export async function getFile(id) {
	const raw = await redis.redis.hget(FILES_KEY, id)
	if (!raw) return null
	try { return JSON.parse(raw) } catch { return null }
}

/**
 * Append a finalized file record. Evicts oldest entries if either
 * cap is exceeded. Returns the list of evicted file ids so the caller
 * can publish 'deleted' events.
 *
 * The cap CHECK is a plain read and can race a concurrent append, so the
 * caps may briefly overshoot before the next append catches up - acceptable
 * for a demo. Each eviction STEP is atomic, which is not merely tidiness:
 * as separate commands, a replica that read a record before another replica
 * removed it would still subtract its bytes, double-decrementing the shared
 * counter. Once that counter goes negative the byte cap stops being enforced
 * and the page renders a negative total.
 */
export async function appendFile(record) {
	const raw = JSON.stringify(record)
	await redis.redis.eval(
		UPSERT_FILE_SCRIPT,
		3,
		FILES_KEY,
		ORDER_KEY,
		BYTES_KEY,
		record.id,
		raw,
		String(record.totalBytes)
	)

	const evictedIds = []
	while (true) {
		const [orderLen, bytesTotalRaw] = await Promise.all([
			redis.redis.llen(ORDER_KEY),
			redis.redis.get(BYTES_KEY)
		])
		const bytesTotal = bytesTotalRaw === null ? 0 : Number(bytesTotalRaw)
		const overCount = orderLen > MAX_FILES
		const overBytes = bytesTotal > MAX_FILE_BYTES && orderLen > 1
		if (!overCount && !overBytes) break
		const evicted = await redis.redis.eval(
			EVICT_OLDEST_SCRIPT,
			3,
			FILES_KEY,
			ORDER_KEY,
			BYTES_KEY,
			record.id
		)
		// Empty list, or the head is the record we just appended and must not
		// evict itself. Inspecting the head without popping it means there is
		// nothing to put back, so the order list cannot be disturbed either.
		if (evicted === null || evicted === '') break
		evictedIds.push(String(evicted))
	}
	return evictedIds
}

export async function statsSnapshot() {
	const [fileCount, bytesTotalRaw] = await Promise.all([
		redis.redis.hlen(FILES_KEY),
		redis.redis.get(BYTES_KEY)
	])
	const bytesStored = bytesTotalRaw === null ? 0 : Number(bytesTotalRaw)
	// chunkCount is derived from the file index's hashes union so it stays
	// consistent across replicas (vs the per-replica `chunks.size` Map,
	// which reflects only this worker's stored bytes).
	const files = await listFiles()
	const uniqueHashes = new Set()
	for (const f of files) {
		if (Array.isArray(f.hashes)) {
			for (const h of f.hashes) uniqueHashes.add(h)
		}
	}
	return {
		fileCount,
		chunkCount: uniqueHashes.size,
		bytesStored
	}
}

/**
 * Drop one file from the index. Returns true if the id existed.
 */
export async function removeFile(id) {
	const removed = await redis.redis.eval(
		REMOVE_FILE_SCRIPT,
		3,
		FILES_KEY,
		ORDER_KEY,
		BYTES_KEY,
		id
	)
	return Number(removed) === 1
}

export const CHUNK_REDIS_PREFIX = 'demo-upload:chunk:'

/**
 * In-flight upload counter. Incremented at handler-entry, decremented in
 * a finally so an abort / throw still releases the slot. Used by the
 * 5-minute upload purge cron to skip when an upload is actively writing
 * - clearing chunks mid-stream would yank already-stored bytes from
 * under the handler.
 *
 * Per-instance: the cron is leader-gated and uploads are per-instance
 * (sticky WS), so the leader checking its own in-flight count is the
 * common case. A cross-instance race (leader purges while a sibling has
 * an in-flight upload) is acceptable for a demo.
 */
let _activeUploads = 0

export function beginUpload() {
	_activeUploads++
}

export function endUpload() {
	if (_activeUploads > 0) _activeUploads--
}

export function activeUploadCount() {
	return _activeUploads
}

/**
 * Drop every file record + clear the per-replica chunk buffer + reset
 * the bytes counter. Returns the file ids before wipe so the caller
 * can publish 'deleted' events with the ids in scope.
 */
export async function purgeMemory() {
	const ids = await redis.redis.lrange(ORDER_KEY, 0, -1)
	const pipeline = redis.redis.multi()
	pipeline.del(FILES_KEY)
	pipeline.del(ORDER_KEY)
	pipeline.del(BYTES_KEY)
	await pipeline.exec()
	chunks.clear()
	return ids
}

/**
 * Walk every Redis key under the demo-upload chunk prefix and DEL them.
 * Uses SCAN to avoid blocking the server on KEYS for large keyspaces.
 * No-op when REDIS_URL is empty (chunkIdempotency null, no keys to
 * clear). Goes through the wrapper's `key()` helper so any outer
 * keyPrefix the deployment configures is honored.
 */
export async function purgeRedisChunks() {
	if (!chunkIdempotency || !redis?.redis) return 0
	const pattern = redis.key(CHUNK_REDIS_PREFIX + '*')
	let cursor = '0'
	let total = 0
	do {
		const [next, keys] = await redis.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
		cursor = next
		if (keys.length > 0) {
			await redis.redis.del(...keys)
			total += keys.length
		}
	} while (cursor !== '0')
	return total
}
