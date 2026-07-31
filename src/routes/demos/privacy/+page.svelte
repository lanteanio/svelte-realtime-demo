<!--
	/demos/privacy - k-anonymity + differential privacy on aggregates.

	Pick a mood; the RAW card moves immediately with exact values while
	the PROTECTED card holds until 3 distinct people have submitted in
	the current one-minute round - and then publishes with calibrated
	Laplace noise. Below k the protected card simply does not move:
	suppression means the k-drop itself is invisible.
-->
<script>
	import { onMount } from 'svelte'
	import { submitMood, roundInfo, rawMood, privateMood } from '$live/demos/privacy'

	let { data } = $props()
	const me = $derived(data.identity)

	let raw = $state(/** @type {{ sum: number, n: number, avg: number } | undefined} */ (undefined))
	let protectedState = $state(/** @type {{ sum: number, n: number, avg: number } | undefined} */ (undefined))

	$effect(() => {
		const offs = [
			rawMood.round.subscribe((v) => { raw = v ?? undefined }),
			privateMood.round.subscribe((v) => { protectedState = v ?? undefined })
		]
		return () => { for (const off of offs) off() }
	})

	let round = $state(/** @type {{ distinct: number, k: number, everPublished: boolean, resetInSeconds: number } | null} */ (null))
	let lastError = $state('')
	let submitting = $state(false)
	let submittedScore = $state(/** @type {number | null} */ (null))

	async function refreshRound() {
		try {
			round = await roundInfo()
		} catch (err) {
			lastError = err?.message ?? String(err)
		}
	}

	onMount(() => {
		refreshRound()
		const timer = setInterval(refreshRound, 5000)
		return () => clearInterval(timer)
	})

	async function handleSubmit(score) {
		if (submitting) return
		submitting = true
		lastError = ''
		try {
			await submitMood(score)
			submittedScore = score
			await refreshRound()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			submitting = false
		}
	}

	const MOODS = [
		{ score: 1, emoji: '😫', label: 'rough' },
		{ score: 2, emoji: '🙁', label: 'meh' },
		{ score: 3, emoji: '😐', label: 'okay' },
		{ score: 4, emoji: '🙂', label: 'good' },
		{ score: 5, emoji: '😄', label: 'great' }
	]

	function fmt(x, digits = 2) {
		return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : '-'
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Aggregate privacy: k-anonymity + differential privacy</h1>
		<p class="text-sm opacity-70 mt-1">
			One "team mood" source topic, two <code>live.aggregate</code> exports with
			identical reducers. The raw one publishes exact values on every submission.
			The protected one declares <code>privacy: &#123; k: 3, epsilon: 1.0, noise:
			'laplace', strategy: 'hybrid' &#125;</code>: below 3 distinct contributors in
			the current one-minute round it simply <strong>does not move</strong> - the
			last published value is held, never replaced with a null or a marker, because
			the drop below k is itself the signal k-anonymity hides. At k it publishes
			with calibrated Laplace noise.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Submitting as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				- open this page in two more browsers (or incognito windows) to cross k = 3.
			</p>
		{/if}
	</header>

	<!-- Mood picker -->
	<section class="card bg-base-200" data-testid="pv-picker-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">How is your day? (each submission feeds both aggregates)</h2>
			<div class="flex flex-wrap gap-2">
				{#each MOODS as m (m.score)}
					<!-- The page's single participatory act: keep the compact dress on
					     fine pointers, meet the 44px platform floor where taps land. -->
					<button
						class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						class:btn-primary={submittedScore === m.score}
						onclick={() => handleSubmit(m.score)}
						disabled={submitting}
						data-testid="pv-submit-{m.score}"
						title={m.label}
					>
						<span class="text-lg leading-none">{m.emoji}</span>
						<span class="opacity-60">{m.score}</span>
					</button>
				{/each}
			</div>
			{#if submittedScore !== null}
				<p class="text-xs opacity-60" data-testid="pv-submit-note">
					Submitted {submittedScore}/5. Submit again anytime - every event counts,
					but the k-cohort counts <strong>distinct</strong> contributors.
				</p>
			{/if}
			{#if lastError}
				<p class="text-xs text-error" data-testid="pv-error">{lastError}</p>
			{/if}
		</div>
	</section>

	<!-- Raw vs protected -->
	<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
		<section class="card bg-base-100 border border-base-300" data-testid="pv-raw-card">
			<div class="card-body py-3 space-y-1">
				<div class="flex justify-between items-baseline">
					<h2 class="card-title text-sm">Raw (this round)</h2>
					<span class="text-xs opacity-50">exact, every event</span>
				</div>
				{#if raw && raw.n > 0}
					<p class="text-4xl font-bold tabular-nums" data-testid="pv-raw-avg">{fmt(raw.avg)}</p>
					<p class="text-xs opacity-60">
						average of <span class="font-mono" data-testid="pv-raw-n">{raw.n}</span>
						submission{raw.n === 1 ? '' : 's'}
					</p>
				{:else}
					<p class="opacity-40 text-sm" data-testid="pv-raw-empty">No submissions this round yet.</p>
				{/if}
			</div>
		</section>

		<section class="card bg-base-100 border border-base-300" data-testid="pv-protected-card">
			<div class="card-body py-3 space-y-1">
				<div class="flex justify-between items-baseline">
					<h2 class="card-title text-sm">Protected (this round)</h2>
					<span class="text-xs opacity-50">k = 3, Laplace noise</span>
				</div>
				<div data-testid="pv-protected-value-area">
					<!-- The initial serve is an un-noised zero seed, not a real
					     publish; without the everPublished gate a pristine server
					     shows "0.00 (last published value)" for a publish that
					     never happened. `round` stays null until its RPC returns,
					     and that RPC is slower than the aggregate's in-memory
					     serve, so the gate holds rather than assuming: a
					     permissive fallback would flash the seed for exactly
					     that window, which is the reading being prevented. -->
					{#if protectedState !== undefined && round?.everPublished === true}
						<p class="text-4xl font-bold tabular-nums" data-testid="pv-protected-value">{fmt(protectedState.avg)}</p>
						<p class="text-xs opacity-60">
							noisy average of a noisy <span class="font-mono" data-testid="pv-protected-n">{fmt(protectedState.n, 1)}</span>
							submissions (last published value; held while below k)
						</p>
					{:else}
						<p class="opacity-40 text-sm" data-testid="pv-protected-held">
							Held. Nothing has been published yet: no round has reached
							3 distinct contributors.
						</p>
					{/if}
				</div>
				{#if round}
					<p class="text-xs opacity-50 border-t border-base-300 pt-2 mt-1" data-testid="pv-round-hint">
						<span data-testid="pv-round-distinct">{round.distinct}</span> of
						<span data-testid="pv-round-k">{round.k}</span> distinct contributors this
						round (resets in ~<span data-testid="pv-round-reset">{round.resetInSeconds}</span>s).
						You can see this only because
						the raw aggregate exists for comparison - the protected output alone never
						reveals its cohort size.
					</p>
				{/if}
			</div>
		</section>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2" data-testid="pv-explainer">
		<p>
			Server: two exports over one source - <code>rawMood = live.aggregate(source,
			reducers, &#123; topic &#125;)</code> and <code>privateMood =
			live.aggregate(source, reducers, &#123; topic, privacy: &#123; k: 3, epsilon: 1.0,
			noise: 'laplace', strategy: 'hybrid', contributor: (d) =&gt; d.userId &#125;
			&#125;)</code>. Privacy is declaration-time; the reducers are untouched.
		</p>
		<p>
			Both aggregates run a per-minute tumbling window, so the k-anonymity cohort
			re-earns its k every round (a lifetime cohort would pass the gate forever after the third
			visitor ever). The noise offset is seeded per (topic, window): every cluster
			replica emits identical values, and a fresh window draws fresh noise. A fresh
			subscriber below k sees the held value, never the live below-k aggregate.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/privacy.js">privacy.js</a>.
		</p>
	</aside>
</div>
