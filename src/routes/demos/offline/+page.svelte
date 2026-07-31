<!--
	/demos/offline - durable offline queue with idempotent replay.

	The wow flow to film:

	1. DevTools > Network > Offline (or kill the network). Post three
	   entries. Nothing errors: each call queues and the "queued edits"
	   counter climbs to 3.

	2. RELOAD THE TAB while still offline. The queue survives - the
	   three mutations were persisted to IndexedDB, scoped to this
	   identity via persistKey.

	3. Go back online. `uploading` flips true while the drain replays,
	   the three entries land in the list EXACTLY once (every persisted
	   mutation carries an idempotency key; the server's live.idempotent
	   wrapper answers a duplicate with the original result), and the
	   checkpoint readout advances.

	Mechanism: configure({ offline: { queue, persist, persistKey } })
	turns queueing on; pendingMutations / uploading / offlineCheckpoint()
	are the consumer surface this page renders.
-->
<script>
	import { pendingMutations, uploading, offlineCheckpoint } from 'svelte-realtime/client'
	import { configureApp } from '$lib/configure-app'
	import { entriesStream, addEntry } from '$live/demos/offline'
	import { browser } from '$app/environment'

	let { data } = $props()
	const me = $derived(data.identity)

	// configureApp() keeps the app-wide options (resume grace, protocol
	// version) while adding the offline queue. Enabling the queue here
	// means every RPC in the tab gains offline queueing once this page has
	// been visited - acceptable for a demo gallery, and exactly how a real
	// app would wire it (once, at startup). persistKey scopes the
	// IndexedDB queue to this identity so one browser profile never
	// replays another login's mutations.
	configureApp({
		offline: {
			queue: true,
			persist: true,
			persistKey: data.identity.id,
			maxQueue: 100
		}
	})

	let entries = $state([])
	$effect(() => {
		const off = entriesStream.subscribe((v) => { entries = Array.isArray(v) ? v : [] })
		return () => off()
	})

	// offlineCheckpoint() is a plain function, not a store; re-read it
	// whenever a drain finishes ($uploading flips back to false) plus
	// once on mount. lastUploadedSeq is the highest enqueue seq that
	// replayed successfully; gapDetected flags a hole in the upload
	// order (a later mutation succeeded while an earlier one failed).
	let checkpoint = $state({ lastUploadedSeq: 0, gapDetected: false })
	$effect(() => {
		if (!$uploading) checkpoint = offlineCheckpoint()
	})

	let draft = $state('')
	let lastError = $state('')

	function handlePost() {
		const text = draft.trim()
		if (!text) return
		draft = ''
		lastError = ''
		// Deliberately NOT awaited: while offline the promise settles only
		// when the queued call replays after reconnect (minutes, maybe).
		// Blocking the composer on that would defeat the demo. Failures
		// (validation, replay errors with live promise holders) surface
		// inline through the catch.
		addEntry(text).catch((err) => {
			lastError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
		})
	}

	function timeOf(ts) {
		return new Date(ts).toLocaleTimeString()
	}

	// -- In-page "simulate offline" so the demo tells its own story without
	// DevTools. There is no public client API to pause the socket, so this
	// leans on two mechanisms the adapter client already supports:
	//
	//  1. The client drops its live socket on the browser `offline` event and
	//     reconnects on `online` (that drop is exactly what arms the realtime
	//     offline queue). We dispatch those events by hand.
	//  2. To STAY offline until Reconnect (the queue drains on any successful
	//     reconnect), we temporarily swap `window.WebSocket` for a stub that
	//     never opens, so the client's reconnect attempts keep failing. The
	//     client's `maxReconnectAttempts` default is Infinity, so a blocked
	//     reconnect loop can never wedge into a terminal failed state; the
	//     backoff just grows until we restore the real socket and dispatch
	//     `online`, which resets the backoff and reconnects immediately.
	//
	// This is a demo affordance to make the queue story visible in-page. A
	// first-class client-side "simulate offline" primitive would be the proper
	// home for it; until then this stays scoped to this demo page.
	let simulatedOffline = $state(false)
	let realWebSocket = null

	function installOfflineBlock() {
		if (!browser || realWebSocket) return
		const Real = window.WebSocket
		realWebSocket = Real
		window.WebSocket = class OfflineSocket {
			static CONNECTING = Real.CONNECTING
			static OPEN = Real.OPEN
			static CLOSING = Real.CLOSING
			static CLOSED = Real.CLOSED
			constructor() {
				this.readyState = Real.CONNECTING
				this.binaryType = 'arraybuffer'
				this.onopen = null
				this.onclose = null
				this.onmessage = null
				this.onerror = null
				// Never reach OPEN. Fail on the next tick so the client sees a
				// normal transient (1006) drop, classifies it RETRY, and keeps
				// the offline queue armed while it schedules the next attempt.
				setTimeout(() => {
					this.readyState = Real.CLOSED
					this.onclose?.({ code: 1006, reason: 'simulated offline', wasClean: false })
				}, 0)
			}
			send() {}
			close() { this.readyState = Real.CLOSED }
			addEventListener() {}
			removeEventListener() {}
		}
	}

	function removeOfflineBlock() {
		if (!browser || !realWebSocket) return
		window.WebSocket = realWebSocket
		realWebSocket = null
	}

	function goOffline() {
		if (!browser) return
		simulatedOffline = true
		installOfflineBlock()
		window.dispatchEvent(new Event('offline'))
	}

	function goOnline() {
		if (!browser) return
		simulatedOffline = false
		removeOfflineBlock()
		window.dispatchEvent(new Event('online'))
	}

	function toggleOffline() {
		if (simulatedOffline) goOnline()
		else goOffline()
	}

	// Never leave the socket blocked if the viewer navigates away mid-simulation.
	$effect(() => () => {
		if (realWebSocket) {
			removeOfflineBlock()
			if (browser) window.dispatchEvent(new Event('online'))
		}
	})
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Offline queue: post now, sync later</h1>
		<p class="text-sm opacity-70 mt-1">
			A guestbook whose posts survive losing the network. With
			<code>offline: &#123; queue: true, persist: true &#125;</code>,
			an entry posted while disconnected queues in IndexedDB, survives
			a full tab reload, and replays exactly once on reconnect - the
			queue synthesizes an idempotency key per mutation and the
			server's <code>live.idempotent</code> wrapper dedups the replay.
		</p>
		<p class="text-sm opacity-70 mt-2">
			Try it right here: hit <strong>Go offline</strong>, sign the
			guestbook a few times (each post queues instead of sending), then
			<strong>Reconnect</strong> and watch the queue replay every entry
			exactly once. No DevTools needed.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Posting as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Queue status strip -->
	<section class="card bg-base-200" data-testid="off-status-strip">
		<div class="card-body py-3">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
				<span>
					<span class="font-bold tabular-nums" data-testid="off-pending-count">{$pendingMutations}</span>
					queued {$pendingMutations === 1 ? 'edit' : 'edits'}
				</span>
				{#if $uploading}
					<span class="flex items-center gap-1 text-info" data-testid="off-uploading">
						<span class="loading loading-spinner loading-xs"></span>
						replaying...
					</span>
				{/if}
				<span class="opacity-60">
					checkpoint: seq
					<span class="font-mono" data-testid="off-checkpoint-seq">{checkpoint.lastUploadedSeq}</span>
				</span>
				{#if checkpoint.gapDetected}
					<span class="badge badge-warning badge-sm" data-testid="off-gap-badge">upload gap detected</span>
				{/if}
			</div>
		</div>
	</section>

	<!-- Simulate offline / reconnect in-page, so the queue -> replay story is
	     visible without opening DevTools. -->
	<section
		class="card {simulatedOffline ? 'bg-warning/10 border border-warning' : 'bg-base-200'}"
		data-testid="off-sim-card"
	>
		<div class="card-body py-3 flex-row flex-wrap items-center justify-between gap-3">
			<div class="text-sm">
				{#if simulatedOffline}
					<span class="badge badge-warning badge-sm mr-2" data-testid="off-sim-badge">simulated offline</span>
					Socket dropped. New posts queue locally - hit Reconnect to replay them exactly once.
				{:else}
					<span class="badge badge-success badge-sm mr-2">online</span>
					Connected. Go offline to watch posts queue and replay on reconnect.
				{/if}
			</div>
			<button
				type="button"
				class="btn btn-sm {simulatedOffline ? 'btn-warning' : 'btn-outline'}"
				onclick={toggleOffline}
				data-testid="off-sim-toggle"
			>
				{simulatedOffline ? 'Reconnect' : 'Go offline'}
			</button>
		</div>
	</section>

	<!-- Composer -->
	<form onsubmit={(e) => { e.preventDefault(); handlePost() }} class="flex gap-2">
		<input
			class="input input-bordered flex-1 bg-base-200"
			bind:value={draft}
			maxlength="200"
			placeholder="Sign the guestbook... (works offline)"
			data-testid="off-input"
		/>
		<button
			type="submit"
			class="btn btn-primary"
			disabled={!draft.trim()}
			data-testid="off-post-button"
		>
			Post
		</button>
	</form>
	{#if lastError}
		<p class="text-xs text-error" data-testid="off-error">{lastError}</p>
	{/if}

	<!-- Entries -->
	<section class="card bg-base-100 border border-base-300 min-h-[16rem]">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">
				Entries <span class="font-normal">(<span data-testid="off-entries-count">{entries.length}</span>, newest first, capped at 50)</span>
			</h2>
			<ul class="space-y-1 text-sm" data-testid="off-entries">
				{#each entries as entry (entry.id)}
					<li class="flex items-baseline gap-2" data-testid="off-entry-{entry.id}">
						<span class="opacity-50 text-xs font-mono w-20 shrink-0">{timeOf(entry.at)}</span>
						<span class="font-semibold shrink-0">{entry.by}</span>
						<span class="flex-1 break-words min-w-0">{entry.text}</span>
					</li>
				{:else}
					<li class="opacity-40 text-center py-6">No entries yet. Sign above - even offline.</li>
				{/each}
			</ul>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Client: <code>configure(&#123; offline: &#123; queue: true, persist: true,
			persistKey &#125; &#125;)</code> queues RPCs while disconnected and
			persists the queue to IndexedDB. The status strip renders the
			consumer stores: <code>pendingMutations</code> (live queued count),
			<code>uploading</code> (true while the reconnect drain replays), and
			<code>offlineCheckpoint()</code> (last uploaded seq + gap flag).
		</p>
		<p>
			Server: <code>addEntry</code> wraps in <code>live.idempotent</code>
			over the cluster-shared Redis store - the documented pairing for the
			durable queue, since every persisted mutation replays with an
			idempotency key. Entries live in a Redis list (LPUSH + LTRIM 50)
			behind a <code>live.stream</code> with <code>prepend: true</code>.
			Source:
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/offline.js">src/live/demos/offline.js</a>
		</p>
	</aside>
</div>
