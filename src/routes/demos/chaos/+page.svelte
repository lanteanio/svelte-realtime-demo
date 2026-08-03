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
	let actionError = $state(null)

	let ticks = $state([])

	// The reproducibility claim is "the same seed paints the same pattern",
	// and checking it used to mean remembering 60 random cells. The run the
	// server actually accepted is kept (its own rounded seed, not the input
	// box), and pinned on stop so the next run has something to line up
	// against - cell for cell, because both strips always lay out 60 slots.
	const STRIP_SLOTS = 60
	let activeRun = $state(null)
	let previousRun = $state(null)

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
		actionError = null
		try {
			const r = await startChaos({ seed: seedInput, dropRate })
			if (r.ok) {
				running = true
				activeRun = { seed: r.seed, dropRate: r.dropRate }
			} else {
				// A refused start used to leave a dead button and no account of
				// itself; the server's reason is the only thing that can tell a
				// bad seed apart from a broken demo.
				actionError = `Could not start: ${r.error ?? 'the server refused the run'}`
			}
		} catch (err) {
			actionError = `Could not start: ${err?.message ?? err}`
		} finally { busy = false }
	}
	async function handleStop() {
		if (busy) return
		busy = true
		actionError = null
		try {
			const r = await stopChaos()
			if (r?.ok === false) {
				actionError = `Could not stop: ${r.error ?? 'the server refused'}`
				return
			}
			// Pin what this run painted, so the next one has a reference. An
			// empty run has nothing to compare against, so it does not replace
			// a pin the visitor may still be using.
			if (activeRun && ticks.length) {
				previousRun = { ...activeRun, cells: ticks.map((t) => ({ id: t.id, dropped: t.dropped, tickN: t.tickN, roll: t.roll })) }
			}
			running = false
			activeRun = null
		} catch (err) {
			actionError = `Could not stop: ${err?.message ?? err}`
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
					<span class="opacity-70 text-xs">Seed (whole number)</span>
					<!-- Compact dress on fine pointers, 44px floor where taps land.
					     Every seed this page produces is a number, so ask for the
					     digit keypad rather than the full alphabet. -->
					<input
						class="input input-bordered input-sm w-32 font-mono pointer-coarse:min-h-11"
						inputmode="numeric"
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
				<!-- Same chip dress as the presets beside it: borderless read as
				     plain text, so the quickest path to a new pattern looked
				     unpressable. -->
				<button class="btn btn-xs pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={randomSeed} disabled={running} data-testid="random-seed">random seed</button>
			</div>
			{#if actionError}
				<p class="text-xs text-error" data-testid="chaos-action-error">{actionError}</p>
			{/if}
		</div>
	</div>

	{#snippet decisionCells(cells, prefix)}
		{#each cells as c (c.id)}
			<!-- 60 cells + 59 hairline gaps must fit the ~240px card at the
			     320px rung; 2px is the floor that keeps one unclipped row. -->
			<div
				class="flex-1 min-w-[2px]"
				class:bg-success={!c.dropped}
				class:bg-error={c.dropped}
				class:opacity-50={c.dropped}
				title={`#${c.tickN} ${c.dropped ? 'DROPPED' : 'kept'} roll=${c.roll}`}
				data-testid={`${prefix}${c.dropped ? 'tick-dropped' : 'tick-kept'}`}
			></div>
		{/each}
		<!-- Unpainted slots stay open so a pinned run and a live one share one
		     geometry: cell n is at the same x in both rows, which is what makes
		     "the same seed paints the same pattern" checkable by eye. -->
		{#each Array.from({ length: Math.max(0, STRIP_SLOTS - cells.length) }) as _, i (i)}
			<div class="flex-1 min-w-[2px] bg-base-300/40"></div>
		{/each}
	{/snippet}

	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			{#if previousRun}
				<div class="space-y-1" data-testid="previous-run">
					<div class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
						<span class="opacity-60" data-testid="previous-caption">
							Previous run - seed {previousRun.seed}, {(previousRun.dropRate * 100).toFixed(0)}% drop rate
						</span>
						<span class="font-mono opacity-60">{previousRun.cells.length} decisions, pinned</span>
					</div>
					<div class="flex gap-px h-6 items-stretch" data-testid="previous-strip">
						{@render decisionCells(previousRun.cells, 'prev-')}
					</div>
				</div>
			{/if}
			<!-- Two whole blocks that wrap, not two columns that collide: at 320
			     these used to interleave into a single garbled line. -->
			<div class="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
				<span class="opacity-60" data-testid="decisions-label">Decisions ({ticks.length} of last {STRIP_SLOTS})</span>
				<span class="font-mono opacity-60" data-testid="counters">
					{deliveredN}/{tickN} delivered ({(empiricalDrop * 100).toFixed(0)}% empirical drop)
				</span>
			</div>
			<div class="flex gap-px h-10 items-stretch" data-testid="decision-strip">
				{#if ticks.length}
					{@render decisionCells(ticks, '')}
				{:else}
					<div class="text-xs opacity-40 self-center mx-auto">
						{running ? 'Waiting for first tick...' : 'Click Start to begin.'}
					</div>
				{/if}
			</div>
			{#if previousRun && activeRun}
				<p class="text-xs opacity-70" data-testid="compare-hint">
					{#if activeRun.seed === previousRun.seed && activeRun.dropRate === previousRun.dropRate}
						Same seed and drop rate as the pinned run - the two rows should
						paint identically, cell for cell.
					{:else}
						Seed {activeRun.seed} at {(activeRun.dropRate * 100).toFixed(0)}% against the
						pinned {previousRun.seed} at {(previousRun.dropRate * 100).toFixed(0)}% - the two
						rows should diverge.
					{/if}
				</p>
			{/if}
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
			Reproducibility check: click Stop and the run stays pinned
			above the live strip. Start again with the same seed and drop
			rate and the new row paints the pinned one cell for cell;
			change the seed and the two rows diverge from the first
			decision. That is the property a test relies on when asserting
			"this scenario causes this bug." The pin is this tab's own
			memory, so reloading clears it.
		</p>
	</aside>
</div>
