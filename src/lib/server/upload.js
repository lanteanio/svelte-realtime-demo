/**
 * Server-side state for /demos/upload.
 *
 * In-memory chunk store and file index. The store is content-addressed:
 * every chunk is hashed by the client (SHA-256), the hash is the key,
 * and the bytes are stored once. A duplicate hash on a fresh upload
 * skips storage entirely - the chunk-store RPC short-circuits via the
 * Redis idempotency cache and reports `dedup: true` to the client.
 *
 * Files are kept under MAX_FILE_BYTES total or MAX_FILES count, whichever
 * is smaller. FIFO eviction drops the oldest file (and any chunks that
 * were exclusive to it) when over capacity.
 */

import { createIdempotencyStore } from 'svelte-adapter-uws-extensions/redis/idempotency'
import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { metrics } from '$lib/server/metrics'

export const MAX_FILES = 30
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const CHUNK_SIZE_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 256 * 1024
export const MAX_FILENAME_LEN = 200

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
			metrics
		})
	: null

/** @type {Map<string, Uint8Array>} hash -> raw bytes */
const chunks = new Map()

/** @type {Map<string, { id: string, filename: string, mime: string, totalBytes: number, totalChunks: number, dedupedChunks: number, hashes: string[], userId: string|null, userName: string|null, uploadedAt: number }>} */
const files = new Map()

/** Newest first. */
const fileOrder = []

let totalBytesStored = 0

export function getChunk(hash) {
	return chunks.get(hash) ?? null
}

export function hasChunk(hash) {
	return chunks.has(hash)
}

export function storeChunk(hash, bytes) {
	if (chunks.has(hash)) return false
	chunks.set(hash, bytes)
	totalBytesStored += bytes.byteLength
	return true
}

export function listFiles() {
	return fileOrder.map((id) => files.get(id)).filter(Boolean)
}

export function getFile(id) {
	return files.get(id) ?? null
}

/**
 * Garbage-collect orphan chunks: any hash not referenced by any
 * surviving file's hash list gets dropped from the chunk Map. Cheap
 * because the in-memory file count is bounded.
 */
function gcOrphanChunks() {
	const live = new Set()
	for (const f of files.values()) {
		for (const h of f.hashes) live.add(h)
	}
	for (const h of chunks.keys()) {
		if (!live.has(h)) {
			const bytes = chunks.get(h)
			chunks.delete(h)
			if (bytes) totalBytesStored -= bytes.byteLength
		}
	}
}

/**
 * Append a finalized file record. Evicts oldest entries if either
 * cap is exceeded. Returns the list of evicted file ids so the caller
 * can publish 'deleted' events.
 */
export function appendFile(record) {
	files.set(record.id, record)
	fileOrder.push(record.id)
	const evictedIds = []
	while (
		fileOrder.length > MAX_FILES ||
		(totalBytesStored > MAX_FILE_BYTES && fileOrder.length > 1)
	) {
		const oldestId = fileOrder.shift()
		if (oldestId && oldestId !== record.id) {
			files.delete(oldestId)
			evictedIds.push(oldestId)
		} else if (oldestId) {
			fileOrder.unshift(oldestId)
			break
		}
	}
	gcOrphanChunks()
	return evictedIds
}

export function statsSnapshot() {
	return {
		fileCount: files.size,
		chunkCount: chunks.size,
		bytesStored: totalBytesStored
	}
}

/**
 * Drop one file from the index. Shared chunks stay in the cache so
 * future uploads can still benefit from dedup; gcOrphanChunks then
 * reclaims any chunk no surviving file references. Returns true if
 * the id existed.
 */
export function removeFile(id) {
	if (!files.has(id)) return false
	files.delete(id)
	const at = fileOrder.indexOf(id)
	if (at >= 0) fileOrder.splice(at, 1)
	gcOrphanChunks()
	return true
}
