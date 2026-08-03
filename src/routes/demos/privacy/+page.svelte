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
	import { submitMood, roundInfo, rawMood, privateMood, inviteCompanions } from '$live/demos/privacy'

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
			tickedReset = round.resetInSeconds
		} catch (err) {
			lastError = err?.message ?? String(err)
		}
	}

	// The countdown is polled every 5s but ticks every second: a frozen
	// number that jumps five at a time sits directly beside a privacy
	// guarantee and reads as breakage. `round.resetInSeconds` is the
	// authoritative reading; this only interpolates between polls and is
	// overwritten by every refresh.
	let tickedReset = $state(/** @type {number | null} */ (null))

	onMount(() => {
		refreshRound()
		const poll = setInterval(refreshRound, 5000)
		const tick = setInterval(() => {
			if (tickedReset !== null && tickedReset > 0) tickedReset -= 1
		}, 1000)
		return () => {
			clearInterval(poll)
			clearInterval(tick)
		}
	})

	let inviting = $state(false)
	async function handleInvite() {
		if (inviting) return
		inviting = true
		lastError = ''
		try {
			await inviteCompanions()
			await refreshRound()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			inviting = false
		}
	}

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
		<p class="text-sm opacity-70 mt-1" data-testid="pv-lede">
			Pick a mood below. The raw card moves at once; the protected one
			stays put until three distinct people have submitted this round,
			then publishes with noise added.
		</p>
		<details class="text-sm opacity-70 mt-1">
			<!-- The spec text used to be nine lines of prose above the only
			     control, so on every phone rung the page opened with a wall of
			     text and no visible action. The one-line lede leads; the
			     mechanism is one tap away for whoever wants it. -->
			<summary class="cursor-pointer" data-testid="pv-mechanism-toggle">How the two aggregates differ</summary>
			<p class="mt-1">
			One "team mood" source topic, two <code>live.aggregate</code> exports with
			identical reducers. The raw one publishes exact values on every submission.
			The protected one declares <code>privacy: &#123; k: 3, epsilon: 1.0, noise:
			'laplace', strategy: 'hybrid' &#125;</code>: below 3 distinct contributors in
			the current one-minute round it simply <strong>does not move</strong> - the
			last published value is held, never replaced with a null or a marker, because
			the drop below k is itself the signal k-anonymity hides. At k it publishes
			with calibrated Laplace noise.
			</p>
		</details>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Submitting as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
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
					<!-- The scale labels used to live only in `title`, so touch
					     visitors never saw them and screen readers announced an
					     emoji plus a bare digit - leaving the 1-5 direction a
					     guess for exactly the people who most need it stated. -->
					<button
						class="btn btn-sm h-auto flex-col gap-0.5 py-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						class:btn-primary={submittedScore === m.score}
						onclick={() => handleSubmit(m.score)}
						disabled={submitting}
						data-testid="pv-submit-{m.score}"
						aria-label="{m.label} - {m.score} of 5"
					>
						<span class="text-lg leading-none">{m.emoji}</span>
						<span class="text-[0.65rem] leading-none opacity-70" data-testid="pv-mood-label-{m.score}">{m.label}</span>
					</button>
				{/each}
			</div>
			{#if submittedScore !== null}
				<p class="text-xs opacity-60" data-testid="pv-submit-note">
					Submitted {submittedScore}/5. Submit again anytime - every event counts,
					but the k-cohort counts <strong>distinct</strong> contributors.
				</p>
			{/if}
			<!-- Crossing k needs three DISTINCT contributors, and "open two
			     more browsers" is not something a phone visitor can do at
			     all - which was most of the audience for the page's headline
			     behaviour. These companions publish ordinary events under
			     their own ids, so k is crossed by the real mechanism; nothing
			     about the gate or the noise is bypassed. -->
			<div class="flex flex-wrap items-center gap-2 pt-1">
				<button
					class="btn btn-sm btn-outline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					onclick={handleInvite}
					disabled={inviting}
					data-testid="pv-invite"
				>
					{inviting ? 'Adding...' : 'Add 2 simulated contributors'}
				</button>
				<span class="text-xs opacity-70" data-testid="pv-invite-note">
					Alone? These are two clearly-marked stand-ins that submit like anyone
					else, so this round can reach k = 3 and the protected card can publish.
				</span>
			</div>
			{#if lastError}
				<p class="text-xs text-error" data-testid="pv-error">{lastError}</p>
			{/if}
		</div>
	</section>

	<!-- Raw vs protected -->
	<div class="grid grid-cols-1 @2xl:grid-cols-2 gap-4">
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
						<!-- "noisy average of a noisy N submissions" parsed as a
						     typo and buried the actual point: the COUNT is noised
						     too, which is why it can be fractional. -->
						<p class="text-xs opacity-60">
							Noise is added to the average and to the submission count alike -
							which is why the count reads
							<span class="font-mono" data-testid="pv-protected-n">{fmt(protectedState.n, 1)}</span>
							rather than a whole number. This is the last published value, held
							while the round sits below k.
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
						round (resets in ~<span data-testid="pv-round-reset">{tickedReset ?? round.resetInSeconds}</span>s).
						<!-- The old wording credited the raw aggregate, which only
						     exposes an event count - never the distinct-contributor
						     count shown here. On a page about honesty, the source of
						     the number has to be named accurately. -->
						You can see this only because a demo-only
						<code>roundInfo()</code> endpoint reports it; neither aggregate
						exposes cohort size, and the protected output never reveals it.
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
