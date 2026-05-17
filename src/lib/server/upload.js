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
 * is smaller. FIFO eviction drops the oldest file when over capacity.
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
const ORDER_KEY = 'demos:upload:order'         // LIST: ids in insertion order (oldest first)
const BYTES_KEY = 'demos:upload:bytes-total'   // counter: sum of totalBytes across surviving files

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
 * Eviction loop is not atomic against concurrent appends from another
 * replica; the worst case is a brief overshoot of the cap before the
 * next append catches up. Acceptable for a demo.
 */
export async function appendFile(record) {
	const raw = JSON.stringify(record)
	const pipeline = redis.redis.multi()
	pipeline.hset(FILES_KEY, record.id, raw)
	pipeline.rpush(ORDER_KEY, record.id)
	pipeline.incrby(BYTES_KEY, record.totalBytes)
	await pipeline.exec()

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
		const oldestId = await redis.redis.lpop(ORDER_KEY)
		if (!oldestId) break
		if (oldestId === record.id) {
			// Refuse to evict the record we just appended; put it back at
			// the front so the FIFO order survives. Matches the original
			// in-memory guard.
			await redis.redis.rpush(ORDER_KEY, oldestId)
			break
		}
		const droppedRaw = await redis.redis.hget(FILES_KEY, oldestId)
		await redis.redis.hdel(FILES_KEY, oldestId)
		if (droppedRaw) {
			try {
				const dropped = JSON.parse(droppedRaw)
				await redis.redis.decrby(BYTES_KEY, dropped.totalBytes)
			} catch { /* corrupt entry: counter may drift slightly */ }
		}
		evictedIds.push(oldestId)
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
	const raw = await redis.redis.hget(FILES_KEY, id)
	if (!raw) return false
	let record
	try { record = JSON.parse(raw) } catch { record = null }
	const pipeline = redis.redis.multi()
	pipeline.hdel(FILES_KEY, id)
	pipeline.lrem(ORDER_KEY, 1, id)
	if (record && typeof record.totalBytes === 'number') {
		pipeline.decrby(BYTES_KEY, record.totalBytes)
	}
	await pipeline.exec()
	return true
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
