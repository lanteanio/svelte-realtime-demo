<!--
	/demos/chaos - deterministic chaos with seed + drop rate.

	Pick a seed and a drop rate. Click Start. The strip below paints
	one cell per server tick (10/sec): green = delivered, red =
	dropped. Same (seed, dropRate) pair always produces the same
	pattern. Stop, change one of the inputs, Start again - watch
	the pattern shift. Reproduce by re-entering the same seed.

	This is the property `createTestEnv({ chaos: { dropRate, seed } })`
	gives you in realtime's test harness. The page is a runtime
	teaching aid; the real harness lives in `svelte-realtime/test`.
-->
<script>
	import { onMount } from 'svelte'
	import { chaosTicks, startChaos, stopChaos, myChaosState } from '$live/demos/chaos'

	let seedInput = $state('1234')
	let dropRate = $state(0.3)
	let running = $state(false)
	let busy = $state(false)

	let ticks = $state([])

	// chaosTicks is a static stream (single-arity topic-fn since
	// realtime ) - subscribe directly, no factory call shape.
	$effect(() => {
		const off = chaosTicks.subscribe((v) => { ticks = v ?? [] })
		return () => off()
	})

	onMount(async () => {
		const s = await myChaosState()
		running = !!s?.running
		if (s?.running) {
			seedInput = String(s.seed)
			dropRate = s.dropRate
		}
	})

	async function handleStart() {
		if (busy) return
		busy = true
		try {
			const r = await startChaos({ seed: seedInput, dropRate })
			if (r.ok) running = true
		} finally { busy = false }
	}
	async function handleStop() {
		if (busy) return
		busy = true
		try {
			await stopChaos()
			running = false
		} finally { busy = false }
	}

	function preset(seed, drop) {
		seedInput = String(seed)
		dropRate = drop
	}

	function randomSeed() {
		seedInput = String(Math.floor(Math.random() * 1_000_000))
	}

	const tickN = $derived(ticks.at(-1)?.tickN ?? 0)
	const deliveredN = $derived(ticks.at(-1)?.deliveredN ?? 0)
	const empiricalDrop = $derived(tickN > 0 ? 1 - deliveredN / tickN : 0)
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Deterministic chaos</h1>
		<p class="text-sm opacity-70 mt-1">
			Seed + drop rate fully determines the decision sequence.
			Same inputs, same green/red pattern. Use it in tests
			(<code>createTestEnv(&#123; chaos: &#123; dropRate, seed &#125; &#125;)</code>) to
			reproduce specific failure paths deterministically.
		</p>
	</header>

	<div class="card bg-base-200">
		<div class="card-body py-3 space-y-3">
			<div class="flex flex-wrap gap-3 items-end">
				<label class="flex flex-col gap-1">
					<span class="opacity-70 text-xs">Seed</span>
					<!-- Compact dress on fine pointers, 44px floor where taps land. -->
					<input
						class="input input-bordered input-sm w-32 font-mono pointer-coarse:min-h-11"
						bind:value={seedInput}
						disabled={running}
						data-testid="seed-input"
					/>
				</label>
				<label class="flex flex-col gap-1 flex-1 min-w-[12rem]">
					<span class="opacity-70 text-xs">Drop rate ({(dropRate * 100).toFixed(0)}%)</span>
					<input
						type="range"
						class="range range-sm pointer-coarse:range-lg pointer-coarse:min-h-11"
						min="0" max="1" step="0.01"
						bind:value={dropRate}
						disabled={running}
						data-testid="drop-rate-input"
					/>
				</label>
				{#if running}
					<button class="btn btn-sm btn-error pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleStop} disabled={busy} data-testid="stop-button">
						Stop
					</button>
				{:else}
					<button class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleStart} disabled={busy} data-testid="start-button">
						Start
					</button>
				{/if}
			</div>
			<div class="flex flex-wrap gap-2 text-xs">
				<span class="opacity-60">Presets:</span>
				<button class="btn btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => preset(1234, 0.3)} disabled={running} data-testid="preset-1234">seed 1234, 30%</button>
				<button class="btn btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => preset(7777, 0.5)} disabled={running} data-testid="preset-7777">seed 7777, 50%</button>
				<button class="btn btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => preset(42, 0.1)} disabled={running} data-testid="preset-42">seed 42, 10%</button>
				<button class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={randomSeed} disabled={running} data-testid="random-seed">random seed</button>
			</div>
		</div>
	</div>

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<div class="flex justify-between text-xs">
				<span class="opacity-60">Decisions ({ticks.length} of last 60)</span>
				<span class="font-mono opacity-60" data-testid="counters">
					{deliveredN}/{tickN} delivered ({(empiricalDrop * 100).toFixed(0)}% empirical drop)
				</span>
			</div>
			<div class="flex gap-px h-10 items-stretch" data-testid="decision-strip">
				{#each ticks as t (t.id)}
					<!-- 60 cells + 59 hairline gaps must fit the ~240px card at the
					     320px rung; 2px is the floor that keeps one unclipped row. -->
					<div
						class="flex-1 min-w-[2px]"
						class:bg-success={!t.dropped}
						class:bg-error={t.dropped}
						class:opacity-50={t.dropped}
						title={`#${t.tickN} ${t.dropped ? 'DROPPED' : 'kept'} roll=${t.roll}`}
						data-testid={t.dropped ? 'tick-dropped' : 'tick-kept'}
					></div>
				{:else}
					<div class="text-xs opacity-40 self-center mx-auto">
						{running ? 'Waiting for first tick...' : 'Click Start to begin.'}
					</div>
				{/each}
			</div>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: per-user state holds <code>seed</code>,
			<code>dropRate</code>, and a Mulberry32 PRNG seeded by it.
			Every 100ms the ticker advances the PRNG, decides drop, and
			publishes a tick record (always - the
			<code>dropped</code> flag is the decision, not the wire
			outcome).
		</p>
		<p>
			Reproducibility check: copy the seed, click Stop, refresh,
			start again with the same seed and drop rate, and watch the
			same pattern emerge. Different seeds give different
			patterns; the same seed always gives the same pattern. That
			is the property a test relies on when asserting "this scenario
			causes this bug."
		</p>
	</aside>
</div>
