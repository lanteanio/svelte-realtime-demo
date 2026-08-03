<!--
	/demos/counter-resume - session resume + replay buffer demo.

	The server ticks a counter every second. Open this page, watch the
	counter advance live. Then DevTools -> Network -> Offline. Wait
	10 seconds. The counter freezes (the WS is dead). Toggle back to
	Online. The counter catches up to the latest value in a single
	frame, filled from the resume protocol's replay buffer - no full
	refetch, no flicker. Because the stream merges with 'set', the whole
	offline gap coalesces into that one frame (the latest value), so the
	ledger does not gain a row per skipped tick; instead the newest row
	is tagged with how many ticks the resume filled at once.

	Without the resume protocol, the reconnect would refetch the
	stream's initial value and skip the gap entirely. Resume preserves
	the per-event sequence so the client knows how much it missed.
-->
<script>
	import { count, reset } from '$live/demos/counter-resume'
	import { confirmDestructive } from '$lib/confirm-destructive'
	import { goOffline, goOnline, offlineBlockActive } from '$lib/simulate-offline'
	import { status } from 'svelte-adapter-uws/client'
	import { onMount } from 'svelte'

	let ledger = $state([])
	// Flips true on the first stream frame so tests can gate on a real
	// hydrated render instead of the pre-stream fallback.
	let hydrated = $state(false)
	// Rows are keyed by this, never by list position: a prepend must not
	// change the identity of every row below it.
	let ledgerSeq = 0

	// The in-page outage: sever the socket for a fixed window, then
	// restore. This is the experiment the page is about, executable on
	// any browser and any pointer, no DevTools required.
	const DROP_SECONDS = 10
	let dropRemaining = $state(0)
	let dropTimer = null

	function dropConnection() {
		if (dropRemaining > 0) return
		dropRemaining = DROP_SECONDS
		goOffline()
		dropTimer = setInterval(() => {
			dropRemaining -= 1
			if (dropRemaining <= 0) {
				clearInterval(dropTimer)
				dropTimer = null
				goOnline()
			}
		}, 1000)
	}

	onMount(() => {
		// Manual subscribe at mount, single subscription for the page's
		// lifetime. Reading $count inside an $effect creates re-running
		// transient subscriptions and does not reliably propagate updates
		// into derived $state in the demo's tested versions.
		let lastSeen = null
		const off = count.subscribe((v) => {
			if (v == null) return
			hydrated = true
			const ts = Date.now()
			const prev = lastSeen
			lastSeen = v
			const gap = prev != null && v > prev + 1 ? v - prev - 1 : 0
			ledger = [{ id: ledgerSeq++, ts, value: v, gap }, ...ledger].slice(0, 30)
		})
		return () => {
			off()
			// Never leave the socket blocked when the page goes away
			// mid-outage.
			if (dropTimer) clearInterval(dropTimer)
			if (offlineBlockActive()) goOnline()
		}
	})

	// The weakest moment of the old page was its strongest moment of the
	// demo: while offline, a dimmed frozen number with a tiny mono word
	// was all the feedback. The elapsed line keeps the staged outage
	// legible as an outage.
	let offlineFor = $state(0)
	$effect(() => {
		if ($status === 'open') {
			offlineFor = 0
			return
		}
		const started = Date.now()
		const t = setInterval(() => {
			offlineFor = Math.round((Date.now() - started) / 1000)
		}, 500)
		return () => clearInterval(t)
	})

	function statusBadge(s) {
		if (s === 'open') return 'badge-success'
		if (s === 'connecting') return 'badge-warning'
		return 'badge-error'
	}

	// Millisecond timestamps: two once-per-second ticks can share a
	// wall-clock second after delivery jitter, and a 1s clock renders
	// that as an apparent duplicate. The milliseconds keep the ledger's
	// evidence aligned with the once-per-second claim.
	const timeFmt = new Intl.DateTimeFormat('en-US', {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		fractionalSecondDigits: 3
	})

	async function handleReset() {
		if (!confirmDestructive('Reset the shared counter and ledger for every connected visitor?')) return
		await reset()
		ledger = []
	}
</script>

<div class="max-w-2xl mx-auto p-8 space-y-6">
	<header>

		<h1 class="text-2xl font-bold mt-2">Reconnect-resume with no flicker</h1>
		<p class="text-sm opacity-70 mt-1">
			Server ticks every second. Press <strong>Drop the
			connection</strong> - it severs the WebSocket for {DROP_SECONDS}
			seconds right here in the page (your browser's offline toggle
			works too). The counter freezes, then catches up to the latest
			value in one frame, and the newest ledger row is tagged with how
			many ticks the resume filled at once.
		</p>
	</header>

	<div class="card bg-base-200 shadow">
		<div class="card-body items-center text-center py-10">
			<div class="text-sm opacity-60">Server tick count</div>
			<div
				class="text-7xl font-bold tabular-nums"
				class:opacity-50={$status !== 'open'}
				data-testid="counter"
				data-hydrated={hydrated}
			>
				{$count ?? '...'}
			</div>
			<div class="text-xs opacity-60 mt-2">
				WebSocket: <span class="badge badge-xs font-mono {statusBadge($status)}" data-testid="ws-status">{$status}</span>
			</div>
			{#if $status !== 'open'}
				<div class="text-xs text-warning mt-1" data-testid="offline-elapsed">
					offline for {offlineFor}s - the reconnect will fill the gap in one frame
				</div>
			{/if}
		</div>
	</div>

	<div class="space-y-1">
		<div class="flex gap-3 justify-center flex-wrap">
			<button
				class="btn btn-primary btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
				onclick={dropConnection}
				disabled={dropRemaining > 0}
				data-testid="drop-connection"
			>
				{dropRemaining > 0 ? `offline - back in ${dropRemaining}s` : `Drop the connection (${DROP_SECONDS}s)`}
			</button>
			<button class="btn btn-outline btn-error btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleReset} data-testid="reset-button">Reset counter + ledger</button>
		</div>
		<p class="text-xs opacity-70 text-center" data-testid="reset-shared-note">
			One counter for everyone: Reset affects every connected visitor.
		</p>
	</div>

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-4">
			<h2 class="card-title text-sm">Event ledger (newest first)</h2>
			<p class="text-xs opacity-60">
				Each row is one received event. Rows marked
				<span class="badge badge-warning badge-xs align-middle">replayed</span>
				arrived after a sequence break (recovered via the replay
				buffer). Timestamps carry milliseconds: delivery jitter can
				land two once-per-second ticks in the same wall-clock second,
				and the milliseconds show they are still distinct events.
			</p>
			<ul class="text-xs space-y-1 font-mono mt-2 max-h-72 overflow-y-auto" data-testid="ledger">
				{#each ledger as entry (entry.id)}
					<li class="flex justify-between gap-3 items-center" data-testid="ledger-row" data-value={entry.value}>
						<span class="opacity-60">{timeFmt.format(entry.ts)}</span>
						{#if entry.gap > 0}
							<span class="badge badge-warning badge-xs" data-testid="gap-badge">+{entry.gap} replayed</span>
						{/if}
						<span class="font-bold">tick = {entry.value}</span>
					</li>
				{/each}
				{#if ledger.length === 0}
					<li class="opacity-40 text-center py-2">Waiting for first tick...</li>
				{/if}
			</ul>
		</div>
	</div>

	<aside class="text-xs opacity-70 leading-relaxed space-y-2">
		<p>
			Server: <code>setInterval</code> publishes once per second on
			<code>demos:counter:tick</code>. The publish is captured in the
			Redis replay buffer (200 entries) via the platform wrap in
			<code>hooks.ws.js</code>.
		</p>
		<p>
			Client reconnect: the adapter sends <code>resume</code> with
			the previous <code>sessionId</code> + <code>lastSeenSeqs</code>
			per topic. Server-side, the replay extension's
			<code>resumeHook</code> gap-fills via the
			<code>__replay:demos:counter:tick</code> pipeline; the client
			receives those buffered ticks as one replay batch that stream
			<code>merge: 'set'</code> collapses to the latest value. The gap
			badge above shows when that batch stood in for more than one
			skipped tick.
		</p>
	</aside>
</div>
