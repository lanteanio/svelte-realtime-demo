<!--
	/demos/upload - cross-device file uploads with content-addressed
	chunk dedup, on top of `live.upload`.

	Pick a file. The page hands it to `uploadFile(file, args)` and
	the framework streams it server-side as a sequence of binary
	chunks. The handler hashes each chunk (SHA-256), routes through
	the redis idempotency cache, and stores fresh bytes once. Re-
	uploading the same file stores zero new bytes. On stream end the
	server fires `live.notify({ userId }, ...)` and every other tab
	the same user has open shows a "new file" banner.

	Three primitives wired here: live.upload (the streaming primitive
	that supersedes the manual live.binary chunked-RPC pattern this
	demo originally shipped with), SHA-256 content addressing,
	redis/idempotency for cluster-wide dedup, and live.notify for
	the fire-and-forget cross-device push.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import { onPush, configure } from 'svelte-realtime/client'
	import {
		uploadedFiles,
		uploadStats,
		myUploadState,
		uploadFile,
		clearFiles
	} from '$live/demos/upload'

	// Pin a fixed 64KB chunk size so the dedup story stays clean across
	// uploads. Without this, live.upload's auto-discovery uses
	// 12KB on the first upload and ~943KB after the platform's
	// maxPayloadLength is announced; the chunk boundaries differ between
	// runs, so the SHA-256 hashes never match and the cache never hits.
	// Adapter default `maxPayloadLength` raised from 16KB to 1MB in
	// , so 1MB chunks ride the new default with no extra
	// adapter config required. 7-8 chunks for a 6.84MB file, dedup
	// math stays clean.
	configure({ upload: { chunkSize: 1024 * 1024 } })

	let { data } = $props()
	const me = $derived(data.identity)

	let maxFileBytes = $state(50 * 1024 * 1024)
	let maxFiles = $state(30)
	let idempotencyEnabled = $state(false)

	let files = $state([])
	let stats = $state({ fileCount: 0, chunkCount: 0, bytesStored: 0 })

	let uploading = $state(false)
	let progress = $state({ sent: 0, total: 0, chunks: 0, deduped: 0, filename: '' })
	let lastError = $state('')
	let lastResult = $state(null)
	let activeHandle = $state(null)

	let incoming = $state([])
	let unregisterPush = null

	$effect(() => {
		const offs = [
			uploadedFiles.subscribe((v) => { files = Array.isArray(v) ? v : [] }),
			uploadStats.subscribe((v) => { stats = v ?? stats })
		]
		return () => { for (const off of offs) off() }
	})

	onMount(async () => {
		const s = await myUploadState()
		maxFileBytes = s?.maxFileBytes ?? maxFileBytes
		maxFiles = s?.maxFiles ?? maxFiles
		idempotencyEnabled = Boolean(s?.idempotencyEnabled)

		unregisterPush = onPush('demos:upload:incoming', (data) => {
			incoming = [
				{ ...data, receivedAt: Date.now() },
				...incoming
			].slice(0, 5)
			return { ack: 'ok' }
		})
	})

	onDestroy(() => {
		unregisterPush?.()
		activeHandle?.cancel?.()
	})

	const sortedFiles = $derived(
		[...files].sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))
	)

	async function handleFile(e) {
		const file = e.target.files?.[0]
		if (!file) return
		await uploadOne(file)
		e.target.value = ''
	}

	async function uploadOne(file) {
		if (uploading) return
		if (file.size > maxFileBytes) {
			lastError = `file too large (max ${maxFileBytes} bytes)`
			return
		}
		uploading = true
		lastError = ''
		lastResult = null
		progress = { sent: 0, total: file.size, chunks: 0, deduped: 0, filename: file.name }

		const handle = uploadFile(file, {
			filename: file.name,
			mime: file.type || 'application/octet-stream'
		})
		activeHandle = handle

		const offProgress = handle.on('progress', (p) => {
			progress = {
				sent: p.sent,
				total: p.total ?? file.size,
				chunks: p.chunks,
				deduped: progress.deduped,
				filename: file.name
			}
		})

		try {
			const result = await handle
			lastResult = result ?? null
			if (result?.dedupedChunks != null) {
				progress = { ...progress, deduped: result.dedupedChunks }
			}
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			offProgress?.()
			activeHandle = null
			uploading = false
		}
	}

	function handleCancel() {
		activeHandle?.cancel?.('user cancelled')
	}

	async function handleClear() {
		try {
			await clearFiles()
		} catch (err) {
			lastError = err?.message ?? String(err)
		}
	}

	function fmtBytes(n) {
		if (!n && n !== 0) return ''
		if (n < 1024) return `${n} B`
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
		return `${(n / (1024 * 1024)).toFixed(2)} MB`
	}

	function fmtTime(ms) {
		if (!ms) return ''
		return new Date(ms).toLocaleTimeString()
	}

	const dedupPct = $derived(progress.chunks > 0 ? Math.round((progress.deduped / progress.chunks) * 100) : 0)
	const sentPct = $derived(progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0)
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Upload: streaming uploads with content-addressed dedup</h1>
		<p class="text-sm opacity-70 mt-1">
			Pick a file. The page hands it to <code>live.upload</code>; the framework streams it to the
			server as binary chunks, hashes each chunk SHA-256 server-side, and short-circuits via
			<code>redis/idempotency</code> when the hash is already cached. Re-uploading the same file
			stores zero new bytes. On stream end <code>live.notify(&#123; userId &#125;)</code> fires a
			fire-and-forget push so other tabs you have open get a "new file" banner.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1" data-testid="me">
				Uploading as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<div class="card bg-base-200" data-testid="upload-stats-strip">
		<div class="card-body py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
			<div>
				<div class="text-xs opacity-60">Files</div>
				<div class="font-mono text-lg" data-testid="stat-files">{stats.fileCount}</div>
			</div>
			<div>
				<div class="text-xs opacity-60">Unique chunks</div>
				<div class="font-mono text-lg" data-testid="stat-chunks">{stats.chunkCount}</div>
			</div>
			<div>
				<div class="text-xs opacity-60">Bytes stored</div>
				<div class="font-mono text-lg" data-testid="stat-bytes">{fmtBytes(stats.bytesStored)}</div>
			</div>
			<div>
				<div class="text-xs opacity-60">Idempotency</div>
				<div class="font-mono text-sm pt-1" data-testid="stat-idempotency">
					{idempotencyEnabled ? 'redis' : 'memory only'}
				</div>
			</div>
		</div>
	</div>

	<section class="card bg-base-100 border border-base-300" data-testid="upload-form">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Pick a file</h2>
			<div class="flex flex-wrap gap-3 items-end">
				<input
					type="file"
					class="file-input file-input-bordered file-input-sm flex-1 min-w-[16rem]"
					onchange={handleFile}
					disabled={uploading}
					data-testid="file-input"
				/>
				<button
					type="button"
					class="btn btn-ghost btn-sm"
					onclick={handleClear}
					disabled={uploading}
					data-testid="clear-button"
				>
					Clear all
				</button>
			</div>
			{#if uploading || progress.chunks > 0}
				<div class="text-xs space-y-1" data-testid="upload-progress">
					<div class="flex justify-between">
						<span class="truncate">{progress.filename}</span>
						<span>
							<span data-testid="progress-sent">{fmtBytes(progress.sent)}</span> / <span data-testid="progress-total">{fmtBytes(progress.total)}</span>
							(<span data-testid="progress-chunks">{progress.chunks}</span> chunks,
							<span data-testid="progress-deduped">{progress.deduped}</span> deduped, {dedupPct}%)
						</span>
					</div>
					<progress
						class="progress progress-primary w-full"
						value={progress.sent}
						max={progress.total}
					></progress>
					{#if uploading}
						<button type="button" class="btn btn-xs btn-ghost" onclick={handleCancel} data-testid="cancel-button">
							Cancel
						</button>
					{/if}
				</div>
			{/if}
			{#if lastError}
				<p class="text-xs text-error" data-testid="upload-error">{lastError}</p>
			{/if}
			{#if lastResult}
				<p class="text-xs text-success" data-testid="upload-result">
					Done. <span data-testid="result-filename">{lastResult.filename}</span>,
					<span data-testid="result-deduped">{lastResult.dedupedChunks}</span>/<span data-testid="result-total-chunks">{lastResult.totalChunks}</span> chunks deduped.
				</p>
			{/if}
		</div>
	</section>

	{#if incoming.length > 0}
		<section class="card bg-info/10 border border-info" data-testid="incoming-banner">
			<div class="card-body py-3 space-y-1">
				<h2 class="card-title text-sm">New uploads on your other devices</h2>
				<ul class="space-y-1 text-sm">
					{#each incoming as evt (evt.fileId)}
						<li class="flex items-center gap-2" data-testid="incoming-item">
							<span class="badge badge-info badge-sm">push</span>
							<span class="font-medium" data-testid="incoming-filename">{evt.filename}</span>
							<span class="opacity-60 text-xs">
								{fmtBytes(evt.totalBytes)},
								<span data-testid="incoming-deduped">{evt.dedupedChunks}</span>/{evt.totalChunks} deduped
							</span>
							<span class="opacity-40 text-xs ml-auto">{fmtTime(evt.uploadedAt)}</span>
						</li>
					{/each}
				</ul>
			</div>
		</section>
	{/if}

	<section class="card bg-base-100 border border-base-300" data-testid="files-list">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Recent files ({files.length})</h2>
			{#if sortedFiles.length === 0}
				<p class="opacity-40 text-xs" data-testid="files-list-empty">
					No files yet. Pick one above.
				</p>
			{:else}
				<ul class="space-y-2 max-h-96 overflow-y-auto pr-1">
					{#each sortedFiles as f (f.id)}
						<li
							class="border-b border-base-200 pb-2 last:border-0 flex items-start gap-3"
							data-testid="file-row"
							data-file-id={f.id}
						>
							<div class="flex-1 min-w-0">
								<div class="text-sm flex items-baseline gap-2 flex-wrap">
									<span class="font-medium truncate" data-testid="file-row-name">{f.filename}</span>
									<span class="opacity-50 text-xs">{fmtBytes(f.totalBytes)}</span>
									<span class="opacity-50 text-xs">
										<span data-testid="file-row-chunks">{f.totalChunks}</span> chunks
									</span>
									<span class="opacity-50 text-xs">
										<span data-testid="file-row-deduped">{f.dedupedChunks}</span> deduped
									</span>
									<span class="opacity-40 text-[10px] ml-auto">{fmtTime(f.uploadedAt)}</span>
								</div>
								<div class="text-[11px] opacity-50 font-mono truncate">
									{f.id.slice(0, 16)} - by {f.userName ?? '(unknown)'}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Wire format: <code>live.binary</code> ships each chunk as a compact frame
			(0x00 marker + uint16 BE header length + JSON header + raw bytes), no base64.
			The header carries <code>&#123; uploadId, index, hash &#125;</code>; the server
			re-hashes the payload and rejects on mismatch before storing.
		</p>
		<p>
			Dedup: every chunk's SHA-256 is the storage key. The server gates the store
			via <code>chunkIdempotency.acquire(hash)</code>. First writer commits; concurrent
			or repeat writers short-circuit to <code>dedup: true</code>. Two parallel uploads
			of the same file across workers still store every unique chunk exactly once.
		</p>
		<p>
			Cross-device fan-out: <code>live.push(&#123; userId &#125;, ...)</code> targets
			every connection registered under the same userId. The cluster registry routes
			cross-instance hops via Redis. Open this page in two tabs sharing your identity
			cookie - one upload fan-outs to the other tab's banner without a polling tick.
		</p>
	</aside>
</div>
