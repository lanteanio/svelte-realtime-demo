/**
 * /demos/upload - cross-device file uploads with content-addressed
 * chunk dedup, on top of `live.upload`.
 *
 * The pitch: pick a file. The page hands it to `uploadFile(file, args)`
 * and the framework streams it server-side as a sequence of binary
 * chunks. The handler hashes each chunk (SHA-256), checks the redis
 * idempotency cache for that hash, stores fresh bytes once, reports
 * `dedup: true` for every cached hit. Re-uploading the same file
 * stores zero new bytes. On stream end, finalize records the file
 * and `live.notify({ userId }, ...)` fires a fire-and-forget push to
 * every other tab the same user has open.
 *
 * Three primitives in one demo:
 *
 *  - live.upload(handler) - streaming upload primitive.
 *      Wire format is one 0x01 chunk frame per chunk plus a 0x02
 *      cancel frame; the handler consumes `for await chunk of
 *      ctx.stream`. Auto-discovers the adapter's `maxPayloadLength`
 *      (1MB default) and sizes the client pump to 90% of
 *      it; backpressure-paced via `conn.bufferedAmount`. Replaces the
 *      manual live.binary chunked-RPC pattern this demo originally
 *      shipped with.
 *
 *  - Content-addressed dedup via redis/idempotency: every chunk's
 *      SHA-256 is the cache key. First writer commits, repeat writers
 *      short-circuit to dedup. Cluster-wide cache - two workers
 *      uploading the same file in parallel still store each unique
 *      chunk exactly once.
 *
 *  - live.notify({ userId }, ...) - fire-and-forget cross-device push
 *     . Counterpart to live.push for cases where the caller
 *      doesn't need a reply. Returns Promise<void>; never rejects on
 *      offline / timeout / handler-error - silent by design.
 *
 * Storage is in-memory only (see src/lib/server/upload.js). Capped at
 * 50MB total or 30 files, FIFO-evicted.
 */

import { createHash } from 'node:crypto'
import { live, LiveError } from 'svelte-realtime/server'
import { TOPICS } from '$lib/server/topics'
import {
	chunkIdempotency,
	storeChunk,
	listFiles,
	appendFile,
	removeFile,
	statsSnapshot,
	purgeMemory,
	purgeRedisChunks,
	MAX_FILES,
	MAX_FILE_BYTES,
	MAX_CHUNK_BYTES,
	MAX_FILENAME_LEN
} from '$lib/server/upload'

const PUSH_EVENT = 'demos:upload:incoming'

function sha256Hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex')
}

function stripHashes(file) {
	const { hashes, ...rest } = file
	return rest
}

/**
 * Page-load probe. Mirrors the my{Foo}State convention used elsewhere
 * in the gallery so the page can render limits without hard-coding
 * them. live.upload auto-discovers chunk size from the adapter's
 * maxPayloadLength on first round-trip; the page no longer needs to
 * know it.
 */
export const myUploadState = live(async () => ({
	maxFiles: MAX_FILES,
	maxFileBytes: MAX_FILE_BYTES,
	maxFilenameLen: MAX_FILENAME_LEN,
	idempotencyEnabled: chunkIdempotency !== null
}))

/**
 * The headline primitive. live.upload's handler signature is
 * `(ctx, ...args)`; ctx is augmented with:
 *   - ctx.stream  AsyncIterable<Uint8Array> yielding chunks in arrival order
 *   - ctx.signal  AbortSignal that fires on cancel / disconnect / cap exceeded
 *   - ctx.upload  { id, total?, source }
 *
 * We hash each chunk as it arrives, route through the redis idempotency
 * cache, and either store fresh or report dedup. On stream end we
 * compute the file-level id from the concatenated hashes, append to
 * the in-memory index, fire publish + notify, and return the public
 * record (which the framework delivers to the client's await handle).
 *
 * Caps: 50MB per upload (the in-memory store's cap), 4 concurrent per
 * session (live.upload default), 64 buffered chunks before flow-control
 * kicks in. The 256KB MAX_CHUNK_BYTES still applies as a hard ceiling
 * on any individual chunk to defend against client-side oversized
 * frames.
 */
export const uploadFile = live.upload(async (ctx, args) => {
	const filename = typeof args?.filename === 'string' ? args.filename.trim() : ''
	const mime = typeof args?.mime === 'string' ? args.mime.slice(0, 80) : 'application/octet-stream'
	if (filename.length === 0) throw new LiveError('VALIDATION', 'filename required')
	if (filename.length > MAX_FILENAME_LEN) {
		throw new LiveError('VALIDATION', `filename too long (max ${MAX_FILENAME_LEN})`)
	}

	const userId = ctx.user?.id ?? null
	const userName = ctx.user?.name ?? null

	const hashes = []
	let totalBytes = 0
	let dedupedChunks = 0

	for await (const chunk of ctx.stream) {
		if (ctx.signal.aborted) break
		if (chunk.byteLength === 0) continue
		if (chunk.byteLength > MAX_CHUNK_BYTES) {
			throw new LiveError('VALIDATION', `chunk too large (max ${MAX_CHUNK_BYTES})`)
		}

		const hash = sha256Hex(chunk)
		let dedup = false

		if (chunkIdempotency) {
			const slot = await chunkIdempotency.acquire(hash)
			if (slot.acquired) {
				storeChunk(hash, chunk)
				await slot.commit({ stored: true, byteLength: chunk.byteLength })
			} else {
				dedup = true
			}
		} else {
			if (!storeChunk(hash, chunk)) dedup = true
		}

		hashes.push(hash)
		totalBytes += chunk.byteLength
		if (dedup) dedupedChunks++
	}

	if (ctx.signal.aborted) {
		throw new LiveError('CANCELLED', 'upload cancelled')
	}
	if (hashes.length === 0) {
		throw new LiveError('VALIDATION', 'empty upload')
	}
	if (totalBytes > MAX_FILE_BYTES) {
		throw new LiveError('VALIDATION', `file too large (max ${MAX_FILE_BYTES} bytes)`)
	}

	const fileId = sha256Hex(Buffer.from(hashes.join(''), 'utf8'))
	const record = {
		id: fileId,
		filename,
		mime,
		totalBytes,
		totalChunks: hashes.length,
		dedupedChunks,
		hashes,
		userId,
		userName,
		uploadedAt: Date.now()
	}

	const evictedIds = appendFile(record)

	for (const evictedId of evictedIds) {
		ctx.publish(TOPICS.demoUploadFiles, 'deleted', { id: evictedId })
	}
	const publicRecord = stripHashes(record)
	ctx.publish(TOPICS.demoUploadFiles, 'created', publicRecord)
	ctx.publish(TOPICS.demoUploadStats, 'set', statsSnapshot())

	if (userId) {
		live.notify(
			{ userId },
			PUSH_EVENT,
			{
				fileId: record.id,
				filename: record.filename,
				totalBytes: record.totalBytes,
				dedupedChunks: record.dedupedChunks,
				totalChunks: record.totalChunks,
				uploadedAt: record.uploadedAt,
				senderRequestId: ctx.requestId ?? null
			}
		)
	}

	return publicRecord
}, {
	maxSize: MAX_FILE_BYTES,
	maxConcurrentPerSession: 4,
	maxBufferedChunks: 64
})

/**
 * Wipe in-memory files + chunks AND the redis chunk idempotency keys.
 * Unlike clearFiles below (which keeps the Redis cache so a test can
 * still assert dedup), purge is the public-deployment cleanup: nothing
 * the user uploaded survives. Chunk bytes are reproducible per-hash,
 * so dropping the cache only forfeits the cross-restart dedup short-
 * circuit - real correctness is unaffected.
 */
export async function purge(ctx) {
	const ids = purgeMemory()
	for (const id of ids) {
		ctx.publish(TOPICS.demoUploadFiles, 'deleted', { id })
	}
	ctx.publish(TOPICS.demoUploadStats, 'set', statsSnapshot())
	const redisDeleted = await purgeRedisChunks()
	return { files: ids.length, redisKeys: redisDeleted }
}

/**
 * Test-only escape hatch. Wipes the in-memory file list so e2e tests
 * start from a known-empty state. The redis idempotency keys are
 * intentionally NOT cleared - the dedup assertion in test 3 depends
 * on a prior upload's chunk hashes still being cached.
 */
export const clearFiles = live(async (ctx) => {
	const ids = listFiles().map((f) => f.id)
	for (const id of ids) {
		removeFile(id)
		ctx.publish(TOPICS.demoUploadFiles, 'deleted', { id })
	}
	ctx.publish(TOPICS.demoUploadStats, 'set', statsSnapshot())
	return { ok: true, cleared: ids.length }
})

/**
 * Live stream of finalized files. `merge: 'crud'` keyed by id so the
 * page sees per-file create / delete events rather than full set
 * replaces.
 */
export const uploadedFiles = live.stream(
	TOPICS.demoUploadFiles,
	async () => listFiles().map(stripHashes),
	{ merge: 'crud', key: 'id' }
)

/**
 * Live stream of storage stats. `merge: 'set'` because the snapshot
 * is small and replace-each-tick is the natural shape.
 */
export const uploadStats = live.stream(
	TOPICS.demoUploadStats,
	async () => statsSnapshot(),
	{ merge: 'set' }
)
