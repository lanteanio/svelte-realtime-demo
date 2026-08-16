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
	import { status } from 'svelte-adapter-uws/client'
	import { connectionState, isOffline } from '$lib/offline-connection'
	import { configureApp } from '$lib/configure-app'
	import { entriesStream, addEntry } from '$live/demos/offline'
	import { browser } from '$app/environment'
	import { goOffline as blockSocket, goOnline as unblockSocket, offlineBlockActive } from '$lib/simulate-offline'

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

	// Posts this tab has handed to the queue and not yet seen land. The
	// queue's own consumer surface is a COUNT (pendingMutations), so the
	// words themselves exist nowhere the visitor can see them - during the
	// demo's hero flow the guestbook looks like it swallowed the post and
	// the durability claim has to be taken on arithmetic alone. These are
	// this tab's memory only: a reload while offline keeps the mutations
	// (they are in IndexedDB) but not their text, because nothing in the
	// client API can enumerate a persisted queue's payloads.
	let queued = $state(/** @type {Array<{ token: string, text: string, at: number }>} */ ([]))

	function handlePost() {
		const text = draft.trim()
		if (!text) return
		draft = ''
		lastError = ''
		const token = crypto.randomUUID()
		queued = [{ token, text, at: Date.now() }, ...queued]
		// Deliberately NOT awaited: while offline the promise settles only
		// when the queued call replays after reconnect (minutes, maybe).
		// Blocking the composer on that would defeat the demo. Failures
		// (validation, replay errors with live promise holders) surface
		// inline through the catch. Settling either way retires the local
		// echo - the server has answered, so the real row is authoritative.
		addEntry(text)
			.catch((err) => {
				lastError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
			})
			.finally(() => {
				queued = queued.filter((q) => q.token !== token)
			})
	}

	function timeOf(ts) {
		return new Date(ts).toLocaleTimeString()
	}

	// -- In-page "simulate offline" (shared $lib/simulate-offline module:
	// dispatches the browser offline/online events the client already
	// reacts to, and blocks reconnects with a never-opening WebSocket
	// stub until unblocked). This page only tracks which mode it is in.
	let simulatedOffline = $state(false)

	// What the card is allowed to claim, given the real socket AND the
	// simulation. The mapping lives in $lib/offline-connection with unit
	// coverage, because its load-bearing case - the 'connecting' window on
	// every page load being neither up nor down - is a startup state that no
	// browser test against a warm server can reach.
	const connection = $derived(connectionState($status, simulatedOffline))

	function goOffline() {
		if (!browser) return
		simulatedOffline = true
		blockSocket()
	}

	function goOnline() {
		if (!browser) return
		simulatedOffline = false
		unblockSocket()
	}

	function toggleOffline() {
		if (simulatedOffline) goOnline()
		else goOffline()
	}

	// Never leave the socket blocked if the viewer navigates away mid-simulation.
	$effect(() => () => {
		if (offlineBlockActive()) unblockSocket()
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
					<span data-testid="off-checkpoint-gloss">(last post the queue uploaded)</span>
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
		class="card {isOffline(connection) ? 'bg-warning/10 border border-warning' : 'bg-base-200'}"
		data-testid="off-sim-card"
	>
		<div class="card-body py-3 flex-row flex-wrap items-center justify-between gap-3">
			<div class="text-sm">
				{#if connection === 'simulated'}
					<span class="badge badge-warning badge-sm mr-2" data-testid="off-sim-badge">simulated offline</span>
					Socket dropped. New posts queue locally - hit Reconnect to replay them exactly once.
				{:else if connection === 'online'}
					<span class="badge badge-success badge-sm mr-2">online</span>
					Connected. Go offline to watch posts queue and replay on reconnect.
				{:else if connection === 'connecting'}
					<span class="badge badge-ghost badge-sm mr-2" data-testid="off-connecting-badge">connecting</span>
					Opening the connection...
				{:else}
					<span class="badge badge-warning badge-sm mr-2" data-testid="off-down-badge">offline</span>
					The connection is down ({$status}). New posts queue locally and replay exactly
					once when it comes back.
				{/if}
			</div>
			<!-- The most-pressed control of the scripted flow: full button size,
			     and the 44px floor where taps land. -->
			<button
				type="button"
				class="btn pointer-coarse:min-h-11 pointer-coarse:min-w-11 {simulatedOffline ? 'btn-warning' : 'btn-outline'}"
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
			aria-label="Sign the guestbook"
			placeholder="Sign the guestbook..."
			data-testid="off-input"
		/>
		<!-- daisyUI sizes a default btn at 2.5rem = 40px, under the 44pt floor
		     the rest of the suite holds. The toggle beside this one already
		     carries it, so the two controls in the demo's scripted flow
		     disagreed about the standard - and this is the primary action. -->
		<button
			type="submit"
			class="btn btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11"
			disabled={!draft.trim()}
			data-testid="off-post-button"
		>
			Post
		</button>
	</form>
	<!-- "(works offline)" used to live in the placeholder, where it was
	     clipped on every phone rung and disappeared the moment anyone typed.
	     It is the sentence that sells the unit, so it is ordinary copy now. -->
	<p class="text-xs opacity-60" data-testid="off-composer-note">
		Works offline: a post made with no connection queues locally and replays
		exactly once when the connection returns.
	</p>
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
				<!-- Queued posts render as the visitor's own words, ghosted and
				     chipped, at the head of the newest-first list. `data-queued`
				     vs `data-entry` is load-bearing, not decoration: a test
				     asking "did this text land exactly once" must not be able to
				     satisfy itself with a local echo that has not landed at all. -->
				{#each queued as q (q.token)}
					<li class="flex items-baseline gap-2 opacity-60" data-queued data-testid="off-queued-row">
						<span class="opacity-50 text-xs font-mono w-20 shrink-0">{timeOf(q.at)}</span>
						<span class="badge badge-warning badge-xs shrink-0">queued</span>
						<span class="flex-1 break-words min-w-0">{q.text}</span>
					</li>
				{/each}
				{#each entries as entry (entry.id)}
					<li class="flex items-baseline gap-2" data-entry data-testid="off-entry-{entry.id}">
						<span class="opacity-50 text-xs font-mono w-20 shrink-0">{timeOf(entry.at)}</span>
						<span class="font-semibold shrink-0">{entry.by}</span>
						<span class="flex-1 break-words min-w-0">{entry.text}</span>
					</li>
				{/each}
				{#if entries.length === 0 && queued.length === 0}
					<li class="opacity-40 text-center py-6">No entries yet. Sign above - even offline.</li>
				{/if}
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
