<!--
	/demos/counter-resume - session resume + replay buffer demo.

	The server ticks a counter every second. Open this page, watch the
	counter advance live. Then DevTools -> Network -> Offline. Wait
	10 seconds. The counter freezes (the WS is dead). Toggle back to
	Online. The counter jumps to the latest value AND the event ledger
	below shows every tick that fired during the gap, delivered via
	__replay frames - no full refetch, no flicker.

	Without the resume protocol, the reconnect would refetch the
	stream's initial value and skip every event in between. Resume
	preserves the per-event sequence so the client knows it received
	contiguous state.
-->
<script>
	import { count, reset } from '$live/demos/counter-resume'
	import { status } from 'svelte-adapter-uws/client'
	import { onMount } from 'svelte'

	let ledger = $state([])

	onMount(() => {
		// Manual subscribe at mount, single subscription for the page's
		// lifetime. Reading $count inside an $effect creates re-running
		// transient subscriptions and does not reliably propagate updates
		// into derived $state in the demo's tested versions.
		let lastSeen = null
		const off = count.subscribe((v) => {
			if (v == null) return
			const ts = Date.now()
			const prev = lastSeen
			lastSeen = v
			const gap = prev != null && v > prev + 1 ? v - prev - 1 : 0
			ledger = [{ ts, value: v, gap }, ...ledger].slice(0, 30)
		})
		return () => off()
	})

	async function handleReset() {
		await reset()
		ledger = []
	}
</script>

<div class="max-w-2xl mx-auto p-8 space-y-6">
	<header>

		<h1 class="text-2xl font-bold mt-2">Reconnect-resume with no flicker</h1>
		<p class="text-sm opacity-70 mt-1">
			Server ticks every second. Drop the WebSocket via DevTools
			Network &rarr; Offline. Wait 10 seconds. Toggle back online.
			The counter catches up to the latest value AND the ledger
			below shows every tick that fired during the gap.
		</p>
	</header>

	<div class="card bg-base-200 shadow">
		<div class="card-body items-center text-center py-10">
			<div class="text-sm opacity-60">Server tick count</div>
			<div class="text-7xl font-bold tabular-nums" class:opacity-50={$status !== 'open'}>
				{$count ?? '...'}
			</div>
			<div class="text-xs opacity-60 mt-2">
				WebSocket: <span class="font-mono">{$status}</span>
			</div>
		</div>
	</div>

	<div class="flex gap-3 justify-center">
		<button class="btn btn-ghost btn-sm" onclick={handleReset}>Reset counter + ledger</button>
	</div>

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-4">
			<h2 class="card-title text-sm">Event ledger (newest first)</h2>
			<p class="text-xs opacity-60">
				Each row is one received event. Rows marked
				<span class="badge badge-warning badge-xs align-middle">replayed</span>
				arrived after a sequence break (recovered via the replay buffer).
			</p>
			<ul class="text-xs space-y-1 font-mono mt-2 max-h-72 overflow-y-auto">
				{#each ledger as entry, i (i + ':' + entry.value)}
					<li class="flex justify-between gap-3 items-center">
						<span class="opacity-60">{new Date(entry.ts).toLocaleTimeString()}</span>
						{#if entry.gap > 0}
							<span class="badge badge-warning badge-xs">+{entry.gap} replayed</span>
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

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>setInterval</code> publishes once per second on
			<code>demos:counter:tick</code>. The publish is captured in the
			Redis replay buffer (200 entries) via the platform wrap in
			<code>hooks.ws.js</code>.
		</p>
		<p>
			Client reconnect: the adapter sends <code>resume</code> with
			the previous <code>sessionId</code> + <code>lastSeenSeqs</code>
			per topic. The replay extension's <code>resumeHook</code>
			gap-fills via <code>__replay:demos:counter:tick</code> frames.
			Stream <code>merge: 'set'</code> applies the latest value;
			the gap badge above shows when the resume protocol filled in
			more than one tick at once.
		</p>
	</aside>
</div>
