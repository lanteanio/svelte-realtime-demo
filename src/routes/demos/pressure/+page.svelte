<!--
	/demos/pressure - live admission-shedding control panel.

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
	import { confirmDestructive } from '$lib/confirm-destructive'

	const SPARK_WINDOW = 60

	let snap = $state(null)
	let history = $state([])
	let shedRows = $state([])
	let busy = $state(false)
	let busyCount = $state(/** @type {number | null} */ (null))
	let lastBurst = $state(/** @type {{ count: number, ts: number } | null} */ (null))
	let lastError = $state('')
	// Timer-driven so the confirmation actually expires; a render-time age
	// check only re-evaluates when the burst changes and never hides itself.
	let burstFresh = $state(false)
	let burstTimer

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
		busyCount = n
		lastError = ''
		try {
			const r = await generateLoad(n)
			lastBurst = { count: r?.generated ?? n, ts: Date.now() }
			burstFresh = true
			clearTimeout(burstTimer)
			burstTimer = setTimeout(() => { burstFresh = false }, 4000)
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busy = false
			busyCount = null
		}
	}
	async function handleSimulate() { await simulateShed() }
	async function handleClear() {
		if (!confirmDestructive('Clear the shared shed log?')) return
		await clearShedLog()
	}

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

		<h1 class="text-2xl font-bold mt-2">Admission-shedding control panel</h1>
		<p class="text-sm opacity-70 mt-1">
			Live <code>platform.pressure</code> readout + in-page load
			generator. When pressure crosses the admission threshold,
			<code>ctx.shed('background')</code> returns true and the
			entry below shows the real reason. Use "Simulate shed" to
			demo the surface without driving real load.
		</p>
	</header>

	<!-- @2xl, not @3xl: a 768px container rung engages at a 783px viewport, so
	     the old md: (768px viewport) intent was lost at exactly 768. -->
	<div class="grid @2xl:grid-cols-2 gap-4" data-testid="pressure-columns">
		<div class="card bg-base-200">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">Current pressure</h2>
				<div class="flex items-center gap-3 flex-wrap">
					<span class="badge {snap ? reasonClass(snap.reason) : 'badge-ghost'}" data-testid="reason">
						{snap?.reason ?? '...'}
					</span>
					<!-- 0.6: the composite 0..1 pressure scalar behind the reason enum -->
					<span class="text-xs opacity-70">pressure</span>
					<progress
						class="progress progress-warning w-24"
						value={snap?.value ?? 0}
						max="1"
						data-testid="pressure-value"
						title="composite pressure scalar (0..1)"
					></progress>
					<span class="text-xs font-mono tabular-nums" data-testid="pressure-scalar">{(snap?.value ?? 0).toFixed(2)} / 1.00</span>
					<span class="text-xs opacity-60">
						WS: <span class="font-mono">{$status}</span>
					</span>
				</div>
				<!-- Four fixed columns fuse their labels when this card gets too
				     narrow; keyed on the content column, four-up waits until the
				     two-card row gives each stat real room. -->
				<dl class="grid grid-cols-2 @5xl:grid-cols-4 gap-2 text-xs mt-2">
					<div>
						<dt class="opacity-60">subs/conn</dt>
						<dd class="font-bold tabular-nums" data-testid="subscriber-ratio">{(snap?.subscriberRatio ?? 0).toFixed(2)}</dd>
					</div>
					<div>
						<dt class="opacity-60">{snap?.publishRateSource === 'generated-load-dev' ? 'generated/s' : 'publish/s'}</dt>
						<dd
							class="font-bold tabular-nums"
							data-testid="publish-rate"
							data-rate-source={snap?.publishRateSource ?? 'adapter'}
						>{(snap?.publishRate ?? 0).toFixed(0)}</dd>
					</div>
					<div>
						<dt class="opacity-60">heap</dt>
						<dd class="font-bold tabular-nums" data-testid="heap-pct" title="heapUsed / heapTotal - the MEMORY reason fires when this crosses memoryHeapUsedRatio">{((snap?.heapPct ?? 0) * 100).toFixed(0)}%</dd>
					</div>
					<div>
						<dt class="opacity-60">RSS MB</dt>
						<dd class="font-bold tabular-nums" data-testid="memory-mb">{(snap?.memoryMB ?? 0).toFixed(0)}</dd>
					</div>
					<div>
						<dt class="opacity-60">backpressured</dt>
						<dd class="font-bold tabular-nums" data-testid="backpressured-conns" title="connections with a non-empty outbound socket buffer; maxBufferedBytes is the worst one">{snap?.backpressuredConnections ?? 0}</dd>
					</div>
					<div>
						<dt class="opacity-60">max buffered</dt>
						<dd class="font-bold tabular-nums" data-testid="max-buffered">{((snap?.maxBufferedBytes ?? 0) / 1024).toFixed(0)}KB</dd>
					</div>
					<!-- Linux-only kernel signals (cgroup PSI + CFS quota); null
					     off-Linux and outside quota-limited cgroups, so the prod
					     deploy shows them while local dev on Windows/macOS hides
					     them. -->
					{#if snap?.psi != null}
						<div>
							<dt class="opacity-60">PSI cpu-some</dt>
							<dd class="font-bold tabular-nums" data-testid="psi-cpu" title="pressure-stall: % of the last 10s some task waited on CPU">{(snap.psi.cpuSome10 ?? 0).toFixed(1)}%</dd>
						</div>
					{/if}
					{#if snap?.cpuThrottle != null}
						<div>
							<dt class="opacity-60">CFS throttled</dt>
							<dd class="font-bold tabular-nums" data-testid="cpu-throttle" title="fraction of the sample window the process sat suspended by the scheduler quota">{((snap.cpuThrottle.throttledRatio ?? 0) * 100).toFixed(0)}%</dd>
						</div>
					{/if}
				</dl>
				<p class="text-xs opacity-60 mt-1">
					pressure is the composite scalar behind the reason badge - admission
					sheds background work as it reaches 1.00. backpressured counts
					connections with unsent outbound bytes.
				</p>
			</div>
		</div>

		<div class="card bg-base-200">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">
					{snap?.publishRateSource === 'generated-load-dev' ? 'generatedRate (dev)' : 'publishRate'}
					(last {SPARK_WINDOW * 0.5}s)
				</h2>
				<div class="flex items-end h-16 gap-px" data-testid="sparkline">
					{#each history as v, i (i + ':' + v)}
						<!-- Zero samples stay a 1px baseline hairline; only real ticks get bars. -->
						<div
							class="flex-1 bg-primary"
							style:height="{v === 0 ? 1 : Math.max(2, (v / sparkMax) * 64)}px"
							style:opacity={0.5 + (i / Math.max(history.length, 1)) * 0.5}
						></div>
					{:else}
						<div class="opacity-40 text-xs">Waiting for first tick...</div>
					{/each}
				</div>
				<div class="text-xs opacity-60">
					peak: {(history.length ? Math.max(...history) : 0).toFixed(0)} pub/s
				</div>
			</div>
		</div>
	</div>

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-3">
			<h2 class="card-title text-sm">Load generator</h2>
			<div class="flex flex-wrap gap-2 items-center">
				<!-- One action family, one hue - magnitude rides on the label; the
				     warning color stays reserved for Simulate shed. -->
				<button class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => handleLoad(100)} disabled={busy} data-testid="load-100">
					{busyCount === 100 ? 'sending +100...' : '+100'}
				</button>
				<button class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => handleLoad(1000)} disabled={busy} data-testid="load-1000">
					{busyCount === 1000 ? 'sending +1000...' : '+1000'}
				</button>
				<button class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => handleLoad(5000)} disabled={busy} data-testid="load-5000">
					{busyCount === 5000 ? 'sending +5000...' : '+5000 (cap)'}
				</button>
				<button class="btn btn-sm btn-warning pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleSimulate} data-testid="simulate-shed">
					Simulate shed
				</button>
			</div>
			{#if lastBurst && burstFresh}
				<p class="text-xs text-success" data-testid="last-burst">
					sent +{lastBurst.count} events at {fmtTs(lastBurst.ts)}
				</p>
			{/if}
			{#if lastError}
				<p class="text-xs text-error" data-testid="load-error">{lastError}</p>
			{/if}
			<p class="text-xs opacity-60 mt-2">
				Each button publishes N no-op events on
				<code>demos:pressure:noise</code>. Small bursts (&le;200)
				fire in one wire-batched call; larger bursts spread over
				~1.5s so the adapter's 1Hz pressure sampler observes a
				sustained rate across multiple windows. After the burst,
				the handler checks <code>ctx.shed('background')</code>;
				if it fires, a real shed event lands in the log below.
				The <code>publishRatePerSec</code> threshold is set to
				500/sec in <code>svelte.config.js</code> so +1000 / +5000
				reliably trip shedding.
			</p>
		</div>
	</div>

	<div class="card bg-base-100 border border-base-300 min-h-[12rem]">
		<div class="card-body py-3">
			<!-- The clear control lives with the log it clears. -->
			<div class="flex items-center justify-between gap-2">
				<h2 class="card-title text-sm">Shed log ({shedRows.length})</h2>
				<button class="btn btn-sm btn-outline btn-error pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleClear} disabled={shedRows.length === 0} data-testid="clear-shed">
					Clear shed log
				</button>
			</div>
			<!-- Rows are a fixed 39rem grid; without a scroll container the
			     reason column - the payload the intro promises - clips off
			     phone viewports with no cue that it exists. -->
			<ul class="text-xs font-mono space-y-1 overflow-x-auto" data-testid="shed-log">
				{#if shedRows.length > 0}
					<li class="grid grid-cols-[6rem_10rem_8rem_10rem_5rem] gap-3 items-center text-[10px] uppercase tracking-wide opacity-40">
						<span>time</span>
						<span>handler</span>
						<span>class</span>
						<span>reason</span>
						<span>source</span>
					</li>
				{/if}
				{#each shedRows as e (e.id)}
					<li class="grid grid-cols-[6rem_10rem_8rem_10rem_5rem] gap-3 items-center" data-testid="shed-row">
						<span class="opacity-60">{fmtTs(e.ts)}</span>
						<span><span class="badge badge-xs">{e.handler}</span></span>
						<span class="opacity-80">{e.class}</span>
						<span><span class="badge badge-error badge-xs">{e.reason}</span></span>
						<span><span class="badge badge-ghost badge-xs">{e.source}</span></span>
					</li>
				{:else}
					<li class="text-base-content/70 text-center py-4">No shed decisions yet - fire +1000 or press Simulate shed above.</li>
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
			stream. In production, publishRate is computed by the adapter
			from the worker's actual publish frequency. Vite development
			has no pressure sampler, so a clearly labelled generatedRate
			meters only this page's load-generator events instead.
		</p>
	</aside>
</div>
