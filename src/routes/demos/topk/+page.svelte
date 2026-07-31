<!--
	/demos/topk - four leaderboards from one event firehose,
	declared in one config via live.aggregate({ windows }).

	Open the page; the firehose ticks at 1Hz publishing N events per
	second (default 5). Four leaderboards mount in parallel:
	last10s sliding, last1min sliding, this-minute tumbling, lifetime.

	Crank the speed slider; watch sliding adjust immediately. Switch
	bias to "hot" or "monopoly"; watch the leaderboards converge on
	the dominant items. Set speed to 0; watch sliding decay over its
	window while lifetime stays.

	One window config drives all four state slices. The visual delta
	between window types IS the pitch.
-->
<script>
	import { onMount } from 'svelte'
	import { trending, setSpeed, setBias, myTopkState } from '$live/demos/topk'

	let items = $state([])
	let speedVal = $state(5)
	let biasVal = $state('uniform')

	let last10s = $state({ counts: {}, top: [] })
	let last1min = $state({ counts: {}, top: [] })
	let thisMinute = $state({ counts: {}, top: [] })
	let lifetime = $state({ counts: {}, top: [] })

	$effect(() => {
		const offs = [
			trending.last10s.subscribe((v) => { last10s = v ?? { counts: {}, top: [] } }),
			trending.last1min.subscribe((v) => { last1min = v ?? { counts: {}, top: [] } }),
			trending.thisMinute.subscribe((v) => { thisMinute = v ?? { counts: {}, top: [] } }),
			trending.lifetime.subscribe((v) => { lifetime = v ?? { counts: {}, top: [] } })
		]
		return () => { for (const off of offs) off() }
	})

	onMount(async () => {
		const s = await myTopkState()
		items = s?.items ?? []
		speedVal = s?.speed ?? 5
		biasVal = s?.bias ?? 'uniform'
	})

	function nameById(id) {
		return items.find((it) => it.id === id)?.name ?? id
	}

	// Label updates live during the drag; commits are throttled mid-drag and
	// the release handler always sends the final value.
	let speedSendTimer = null
	function handleSpeedInput(e) {
		speedVal = Number(e.target.value)
		if (!speedSendTimer) {
			speedSendTimer = setTimeout(() => {
				speedSendTimer = null
				setSpeed(speedVal)
			}, 250)
		}
	}
	async function handleSpeedChange(e) {
		speedVal = Number(e.target.value)
		if (speedSendTimer) {
			clearTimeout(speedSendTimer)
			speedSendTimer = null
		}
		await setSpeed(speedVal)
	}

	async function handleBias(b) {
		biasVal = b
		await setBias(b)
	}

	const BIASES = [
		{ id: 'uniform',  label: 'Uniform',  hint: '12 items, equal weight' },
		{ id: 'hot',      label: 'Hot',      hint: 'top 3 get 60% combined' },
		{ id: 'monopoly', label: 'Monopoly', hint: 'one item gets 75%' }
	]
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Top-K leaderboards: four windows, one config</h1>
		<p class="text-sm opacity-70 mt-1">
			One firehose, four leaderboards. Sliding (10s and 1min), tumbling (per-minute), and lifetime,
			all declared in a single <code>live.aggregate(&#123; windows &#125;)</code> block. Crank
			the speed slider; watch sliding twitch while the minute window resets sharply on the boundary
			and lifetime drifts up.
		</p>
	</header>

	<div class="card bg-base-200">
		<div class="card-body py-3 space-y-3">
			<div class="flex flex-wrap gap-3 items-end">
				<label class="flex flex-col gap-1 flex-1 min-w-[12rem]">
					<span class="opacity-70 text-xs">Firehose ({speedVal} events/sec)</span>
					<!-- Compact on fine pointers, 44px where taps land. -->
					<input
						type="range"
						class="range range-sm pointer-coarse:range-lg pointer-coarse:min-h-11"
						min="0" max="50" step="1"
						value={speedVal}
						oninput={handleSpeedInput}
						onchange={handleSpeedChange}
						data-testid="speed-input"
					/>
					<div class="flex justify-between text-[10px] opacity-60">
						<span>0 = pause</span>
						<span>50</span>
					</div>
				</label>
				<div class="flex flex-col gap-1">
					<span class="opacity-70 text-xs">Bias</span>
					<div class="join">
						{#each BIASES as b (b.id)}
							<button
								class="btn btn-sm join-item pointer-coarse:min-h-11 pointer-coarse:min-w-11"
								class:btn-primary={biasVal === b.id}
								onclick={() => handleBias(b.id)}
								data-testid="bias-{b.id}"
								title={b.hint}
							>
								{b.label}
							</button>
						{/each}
					</div>
					<span class="text-xs opacity-60" data-testid="bias-hint">
						{BIASES.find((b) => b.id === biasVal)?.hint}
					</span>
				</div>
			</div>
		</div>
	</div>

	<div class="grid grid-cols-1 @2xl:grid-cols-2 gap-4">
		{#each [
			{ key: 'last10s',    title: 'Last 10 seconds',  subtitle: 'sliding window, 1s hops',  data: last10s,    testid: 'lb-last10s' },
			{ key: 'last1min',   title: 'Last minute',      subtitle: 'sliding window, 5s hops',  data: last1min,   testid: 'lb-last1min' },
			{ key: 'thisMinute', title: 'This minute',      subtitle: 'tumbling, resets each min', data: thisMinute, testid: 'lb-thisMinute' },
			{ key: 'lifetime',   title: 'Lifetime',         subtitle: 'never resets',             data: lifetime,   testid: 'lb-lifetime' }
		] as panel (panel.key)}
			<div class="card bg-base-100 border border-base-300" data-testid={panel.testid}>
				<div class="card-body py-3 space-y-2">
					<div class="flex justify-between items-baseline">
						<h2 class="card-title text-sm">{panel.title}</h2>
						<span class="text-xs opacity-50">{panel.subtitle} &middot; bars: share of shown</span>
					</div>
					{#if !panel.data?.top?.length}
						<p class="text-base-content/70 text-xs py-3" data-testid="{panel.testid}-empty">Connecting to firehose...</p>
					{:else}
						{@const totalCount = panel.data.top.reduce((sum, e) => sum + e.count, 0)}
						<ol class="space-y-1" data-testid="{panel.testid}-rows">
							{#each panel.data.top as entry, idx (entry.itemId)}
								<!-- Competition-style tie ranks: equal counts share a rank (1, 1, 3, ...). -->
								{@const rank = panel.data.top.findIndex((e) => e.count === entry.count) + 1}
								<li class="flex items-center gap-2 text-sm" data-testid="{panel.testid}-row">
									<span class="opacity-50 font-mono w-4 shrink-0">{rank}</span>
									<span class="flex-1 min-w-24 truncate" data-testid="{panel.testid}-name">{nameById(entry.itemId)}</span>
									<span class="font-mono text-xs opacity-60 shrink-0 text-right tabular-nums" data-testid="{panel.testid}-count">{entry.count}</span>
									<!-- Share-of-shown normalization keeps the encoding honest (a leader bar
									     is not always full); the bar yields entirely below the narrow rung
									     before the name ever truncates. -->
									<div class="w-16 min-w-0 shrink h-2 bg-base-200 rounded overflow-hidden hidden @xl:block" data-testid="{panel.testid}-bar">
										<div class="h-full bg-primary" style:width="{totalCount > 0 ? (entry.count / totalCount) * 100 : 0}%"></div>
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: one <code>live.aggregate('demos:topk:event', &#123; counts, top &#125;, &#123; topic, windows &#125;)</code>
			declares all four windows. Each window slice maintains its own state and publishes to a derived topic
			at <code>$&#123;topic&#125;:$&#123;windowName&#125;</code>. The vite plugin generates a namespace
			export, so <code>trending.last10s.subscribe(...)</code> Just Works on the client.
		</p>
		<p>
			Sliding windows partition state into hop buckets (10 buckets of 1s for last10s, 12 of 5s for last1min).
			Each <code>reduce</code> writes into the current bucket; on each slide tick the oldest drops and a new
			one starts. The <code>combineCounts</code> built-in merges per-bucket states into the full window state
			at compute time. Tumbling resets at the wall-clock boundary; lifetime never resets.
		</p>
		<p>
			With speed=0 the firehose stops publishing; sliding decays over its window length while lifetime stays.
			With "monopoly" bias one item dominates everywhere; with "uniform" the noise spreads so much that
			leaderboard positions reshuffle constantly on last10s but stay stable on lifetime.
		</p>
	</aside>
</div>
