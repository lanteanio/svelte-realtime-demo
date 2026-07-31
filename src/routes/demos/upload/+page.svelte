<!--
	/demos/upload - streaming file uploads with content-addressed
	chunk dedup, on top of `live.upload`.

	Pick a file. The page hands it to `uploadFile(file, args)` and
	the framework streams it server-side as a sequence of binary
	chunks. The handler hashes each chunk (SHA-256), routes through
	the redis idempotency cache, and stores fresh bytes once. Re-
	uploading the same file stores zero new bytes. On stream end the
	server fires `live.notify({ userId }, ...)` and the most recently
	connected tab for that user shows a "new file" banner.

	Three primitives wired here: live.upload (the streaming primitive
	that supersedes the manual live.binary chunked-RPC pattern this
	demo originally shipped with), SHA-256 content addressing,
	redis/idempotency for cluster-wide dedup, and live.notify for
	most-recent-device fire-and-forget delivery.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import { onPush } from 'svelte-realtime/client'
	import { configureApp } from '$lib/configure-app'
	import { confirmDestructive } from '$lib/confirm-destructive'
	import DemoLede from '$lib/components/DemoLede.svelte'
	import { status as wsStatus } from 'svelte-adapter-uws/client'
	import {
		uploadedFiles,
		uploadStats,
		myUploadState,
		uploadFile,
		clearFiles
	} from '$live/demos/upload'

	// Pin a fixed frame size so the dedup story stays clean across
	// uploads. Without this, live.upload's auto-discovery uses 12KB on
	// the first upload and the adapter cap (1MB by default) thereafter;
	// the chunk boundaries differ between runs, so the SHA-256 hashes
	// never match and the cache never hits.
	//
	// `frameSize` is the max wire-frame bytes per chunk -- the framework
	// subtracts the 10/12+argsLen envelope automatically, so this value
	// can equal the adapter's maxPayloadLength exactly without overflow.
	// 512KB picks an interesting middle: ~14 chunks for a 6.84MB file
	// (clean dedup visualisation), no quibble with the adapter cap.
	configureApp({ upload: { frameSize: 512 * 1024 } })

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
	let incomingSeq = 0
	let pushReady = $state(false)
	let pushHandlerInstalled = $state(false)
	let unregisterPush = null

	$effect(() => {
		const offs = [
			uploadedFiles.subscribe((v) => { files = Array.isArray(v) ? v : [] }),
			uploadStats.subscribe((v) => { stats = v ?? stats })
		]
		return () => { for (const off of offs) off() }
	})

	onMount(async () => {
		// Register the push handler synchronously on mount so a server-fired
		// notify that races a slow myUploadState() RPC still finds a handler.
		// The handler doesn't depend on the discovered limits; the limits
		// only gate the upload form.
		unregisterPush = onPush('demos:upload:incoming', (data) => {
			// fileId is content-addressed, so re-uploading the same file - the
			// demo's headline dedup flow - notifies twice with an identical id.
			// The list key must be unique per NOTIFICATION, not per file, or the
			// second one throws a duplicate-key error and blanks the banner. A
			// timestamp is not enough; two can land in the same millisecond.
			incoming = [
				{ ...data, receivedAt: Date.now(), notifySeq: ++incomingSeq },
				...incoming
			].slice(0, 5)
			return { ack: 'ok' }
		})
		pushHandlerInstalled = true

		const s = await myUploadState()
		maxFileBytes = s?.maxFileBytes ?? maxFileBytes
		maxFiles = s?.maxFiles ?? maxFiles
		idempotencyEnabled = Boolean(s?.idempotencyEnabled)
	})

	// pushReady gates the user-targeted push test: it must mean both
	// "handler installed in the client-side map" AND "WS open so the
	// server-side push registry holds this tab's ws". An always-true
	// gate signalled visibility before the WS connected, so the
	// server's notify routed to the OTHER tab (the only entry in the
	// registry at that moment) and the recipient never saw the banner.
	$effect(() => {
		if ($wsStatus === 'open' && pushHandlerInstalled) pushReady = true
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
			lastError = `file too large (max ${fmtBytes(maxFileBytes)})`
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
		if (!confirmDestructive('Clear all shared uploaded-file records?')) return
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
		<DemoLede>
			Pick a file. The page hands it to <code>live.upload</code>; the framework streams it to the
			server as binary chunks, hashes each chunk SHA-256 server-side, and short-circuits via
			<code>redis/idempotency</code> when the hash is already cached. Re-uploading the same file
			stores zero new bytes. On stream end <code>live.notify(&#123; userId &#125;)</code> sends a
			fire-and-forget push to that user's most recently connected tab, locally or across workers.
		</DemoLede>
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
		<div class="card-body py-3 grid grid-cols-2 @2xl:grid-cols-4 gap-3 text-sm">
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

	<!-- Visibility-only marker for user-targeted push tests: becomes visible once
		 onPush is registered. Tests wait on this before triggering an upload so
		 the server-fired notify cannot race past the recipient's handler. -->
	{#if pushReady}
		<div data-testid="push-ready" hidden></div>
	{/if}

	<section class="card bg-base-100 border border-base-300" data-testid="upload-form">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Pick a file</h2>
			<div class="flex flex-wrap gap-3 items-end">
				<!-- Compact dress on fine pointers, 44px floor where taps land. -->
				<input
					type="file"
					class="file-input file-input-bordered file-input-sm flex-1 min-w-0 w-full @2xl:w-auto @2xl:min-w-[16rem] pointer-coarse:min-h-11"
					onchange={handleFile}
					disabled={uploading}
					aria-label="Pick a file to upload"
					data-testid="file-input"
				/>
				<button
					type="button"
					class="btn btn-outline btn-error btn-sm pointer-coarse:min-h-11"
					onclick={handleClear}
					disabled={uploading || files.length === 0}
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
						<button type="button" class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleCancel} data-testid="cancel-button">
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
				<h2 class="card-title text-sm">Latest upload notifications</h2>
				<ul class="space-y-1 text-sm">
					{#each incoming as evt (evt.notifySeq)}
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
				<p class="text-base-content/70 text-xs" data-testid="files-list-empty">
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
			User-targeted delivery: <code>live.notify(&#123; userId &#125;, ...)</code> targets
			the most recently connected socket registered under that userId. The cluster
			registry applies the same last-write-wins rule across workers. Open this page in
			two tabs sharing your identity cookie: the newer tab becomes the recipient, and
			an upload from the older tab appears there without a polling tick.
		</p>
	</aside>
</div>
