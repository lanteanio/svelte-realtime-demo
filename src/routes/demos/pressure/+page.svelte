<!--
	/demos/pressure -- live admission-shedding control panel.

	Four panels:
	- Current pressure readout (subscriberRatio / publishRate / memoryMB /
	  reason).
	- A 60-tick sparkline of publishRate over the last 30 seconds.
	- Load-generator controls + a simulate-shed button.
	- Recent shed decisions, fed by the realtime shedEvents stream.

	The connection-status badge is the layout's existing 5-state indicator
	(top-right of every page); when generateLoad pushes pressure high
	enough that ctx.shed fires, the entry's `source: 'real'` distinguishes
	it from `source: 'simulated'` in the log.
-->
<script>
	import { onMount } from 'svelte'
	import { pressureSnapshot, shedEvents, generateLoad, simulateShed, clearShedLog } from '$live/demos/pressure'
	import { status } from 'svelte-adapter-uws/client'

	const SPARK_WINDOW = 60

	let snap = $state(null)
	let history = $state([])
	let shedRows = $state([])
	let busy = $state(false)

	onMount(() => {
		const offTick = pressureSnapshot.subscribe((v) => {
			if (!v) return
			snap = v
			history = [...history, v.publishRate ?? 0].slice(-SPARK_WINDOW)
		})
		const offShed = shedEvents.subscribe((v) => { shedRows = (v ?? []).slice().reverse() })
		return () => { offTick(); offShed() }
	})

	const sparkMax = $derived(Math.max(1, ...history))

	async function handleLoad(n) {
		if (busy) return
		busy = true
		try { await generateLoad(n) } finally { busy = false }
	}
	async function handleSimulate() { await simulateShed() }
	async function handleClear() { await clearShedLog() }

	function fmtTs(ts) { return new Date(ts).toLocaleTimeString() }
	function reasonClass(r) {
		switch (r) {
			case 'MEMORY': return 'badge-error'
			case 'PUBLISH_RATE': return 'badge-warning'
			case 'SUBSCRIBERS': return 'badge-warning'
			default: return 'badge-success'
		}
	}
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>
		<a href="/" class="link link-hover text-sm opacity-60">&larr; Home</a>
		<h1 class="text-2xl font-bold mt-2">Admission-shedding control panel</h1>
		<p class="text-sm opacity-70 mt-1">
			Live <code>platform.pressure</code> readout + in-page load
			generator. When pressure crosses the admission threshold,
			<code>ctx.shed('background')</code> returns true and the
			entry below shows the real reason. Use "Simulate shed" to
			demo the surface without driving real load.
		</p>
	</header>

	<div class="grid md:grid-cols-2 gap-4">
		<div class="card bg-base-200">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">Current pressure</h2>
				<div class="flex items-center gap-3">
					<span class="badge {snap ? reasonClass(snap.reason) : 'badge-ghost'}" data-testid="reason">
						{snap?.reason ?? '...'}
					</span>
					<span class="text-xs opacity-60">
						WS: <span class="font-mono">{$status}</span>
					</span>
				</div>
				<dl class="grid grid-cols-3 gap-2 text-xs mt-2">
					<div>
						<dt class="opacity-60">subs/conn</dt>
						<dd class="font-bold tabular-nums" data-testid="subscriber-ratio">{(snap?.subscriberRatio ?? 0).toFixed(2)}</dd>
					</div>
					<div>
						<dt class="opacity-60">publish/s</dt>
						<dd class="font-bold tabular-nums" data-testid="publish-rate">{(snap?.publishRate ?? 0).toFixed(0)}</dd>
					</div>
					<div>
						<dt class="opacity-60">RSS MB</dt>
						<dd class="font-bold tabular-nums" data-testid="memory-mb">{(snap?.memoryMB ?? 0).toFixed(0)}</dd>
					</div>
				</dl>
			</div>
		</div>

		<div class="card bg-base-200">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">publishRate (last {SPARK_WINDOW * 0.5}s)</h2>
				<div class="flex items-end h-16 gap-px" data-testid="sparkline">
					{#each history as v, i (i + ':' + v)}
						<div
							class="flex-1 bg-primary"
							style:height="{Math.max(2, (v / sparkMax) * 64)}px"
							style:opacity={0.5 + (i / Math.max(history.length, 1)) * 0.5}
						></div>
					{:else}
						<div class="opacity-40 text-xs">Waiting for first tick...</div>
					{/each}
				</div>
				<div class="text-xs opacity-60">
					peak: {sparkMax.toFixed(0)} pub/s
				</div>
			</div>
		</div>
	</div>

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-3">
			<h2 class="card-title text-sm">Load generator</h2>
			<div class="flex flex-wrap gap-2">
				<button class="btn btn-sm" onclick={() => handleLoad(100)} disabled={busy} data-testid="load-100">
					+100
				</button>
				<button class="btn btn-sm" onclick={() => handleLoad(1000)} disabled={busy} data-testid="load-1000">
					+1000
				</button>
				<button class="btn btn-sm" onclick={() => handleLoad(5000)} disabled={busy} data-testid="load-5000">
					+5000 (cap)
				</button>
				<button class="btn btn-sm btn-warning" onclick={handleSimulate} data-testid="simulate-shed">
					Simulate shed
				</button>
				<button class="btn btn-sm btn-ghost ml-auto" onclick={handleClear} data-testid="clear-shed">
					Clear shed log
				</button>
			</div>
			<p class="text-xs opacity-60 mt-2">
				Each button publishes N no-op events on
				<code>demos:pressure:noise</code> in one wire-batched call.
				After the burst, the handler checks
				<code>ctx.shed('background')</code>; if it fires, a real
				shed event lands in the log below.
			</p>
		</div>
	</div>

	<div class="card bg-base-100 border border-base-300 min-h-[12rem]">
		<div class="card-body py-3">
			<h2 class="card-title text-sm">Shed log ({shedRows.length})</h2>
			<ul class="text-xs font-mono space-y-1" data-testid="shed-log">
				{#each shedRows as e (e.id)}
					<li class="flex justify-between gap-3" data-testid="shed-row">
						<span class="opacity-60 shrink-0">{fmtTs(e.ts)}</span>
						<span class="badge badge-xs">{e.handler}</span>
						<span class="opacity-80">{e.class}</span>
						<span class="badge badge-error badge-xs">{e.reason}</span>
						<span class="badge badge-ghost badge-xs">{e.source}</span>
					</li>
				{:else}
					<li class="opacity-40 text-center py-4">No shed decisions yet.</li>
				{/each}
			</ul>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>live.admission</code> wired in <code>src/hooks.ws.js</code>
			classifies <code>background</code> handlers as sheddable on
			MEMORY / PUBLISH_RATE / SUBSCRIBERS pressure. Each handler
			opts in via <code>if (ctx.shed('background')) ...</code>.
		</p>
		<p>
			Live snapshot: <code>platform.pressure</code> getter sampled
			every 500ms and republished as a <code>set</code>-merge
			stream. publishRate is computed by the adapter from the
			worker's actual publish frequency over the last sample
			window, so the sparkline reflects every publish from every
			RPC and every cron fire on this worker.
		</p>
	</aside>
</div>
