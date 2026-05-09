<!--
	/demos/from-seq: three-tier reconnect via delta.fromSeq.

	A 1Hz cron publishes events on a topic, each with an
	incrementing seq. The page renders received events with a tier
	badge: `rehydrate` (loader), `live` (cron tick during your
	subscription), or `fromSeq` (gap-fill via the
	`delta.fromSeq(sinceSeq)` bridge after a long pause that
	overflowed the bounded replay buffer).

	Click Pause to drop the subscription. The cron keeps publishing
	server-side. Click Resume to re-subscribe; for short pauses the
	platform's replay buffer fills the gap silently (events arrive
	tagged `live`, their original tier from when they were
	published). For long pauses past the buffer size, the framework
	falls through to `delta.fromSeq`, which reads from the durable
	store and tags each missed entry `fromSeq`.
-->
<script>
	import { onMount } from 'svelte'
	import {
		myFromSeqState,
		eventStream
	} from '$live/demos/from-seq'

	let { data } = $props()
	const me = $derived(data.identity)

	let state = $state({ storeRetain: 200, recentWindow: 20 })

	onMount(async () => {
		try { state = await myFromSeqState() } catch {}
	})

	let entries = $state(/** @type {Array<{ id: string, seq: number, ts: number, message: string, tier: string }>} */ ([]))
	let subscribed = $state(true)
	let pausedAt = $state(/** @type {number | null} */ (null))

	$effect(() => {
		if (!subscribed) return
		const off = eventStream.subscribe((v) => {
			entries = Array.isArray(v) ? v.slice().sort((a, b) => b.seq - a.seq) : []
		})
		return () => off()
	})

	const tierCounts = $derived.by(() => {
		const c = { live: 0, rehydrate: 0, fromSeq: 0 }
		for (const e of entries) {
			if (c[e.tier] !== undefined) c[e.tier]++
		}
		return c
	})

	function tierBadgeClass(t) {
		switch (t) {
			case 'live': return 'badge-success'
			case 'fromSeq': return 'badge-warning'
			case 'rehydrate': return 'badge-info'
			default: return 'badge-ghost'
		}
	}

	function togglePause() {
		if (subscribed) {
			subscribed = false
			pausedAt = Date.now()
		} else {
			subscribed = true
			pausedAt = null
		}
	}

	let nowMs = $state(Date.now())
	let clockTimer = null
	onMount(() => {
		clockTimer = setInterval(() => { nowMs = Date.now() }, 250)
	})

	function pausedFor() {
		if (pausedAt === null) return 0
		return Math.max(0, Math.round((nowMs - pausedAt) / 1000))
	}

	function timeOf(ts) {
		return new Date(ts).toLocaleTimeString()
	}
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>
		<a href="/" class="link link-hover text-sm opacity-60">&larr; Home</a>
		<h1 class="text-2xl font-bold mt-2">Reconnect: three-tier gap fill via delta.fromSeq</h1>
		<p class="text-sm opacity-70 mt-1">
			A 1Hz <code>live.cron</code> publishes events tagged
			<code>live</code>. The loader returns the recent window tagged
			<code>rehydrate</code>. <code>delta.fromSeq(sinceSeq)</code>
			reads from the same durable store and tags <code>fromSeq</code>
			on every event it returns. Pause the subscription, wait, resume:
			the framework's bounded replay buffer covers short gaps (events
			arrive with their original <code>live</code> tag, transparent
			to the page); for longer gaps past the buffer size,
			<code>delta.fromSeq</code> fills the rest tagged
			<code>fromSeq</code>.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Watching as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Controls + summary -->
	<section class="card bg-base-200" data-testid="controls-section">
		<div class="card-body py-3 space-y-2">
			<div class="flex flex-wrap items-center gap-2">
				<button
					class="btn btn-sm {subscribed ? 'btn-warning' : 'btn-success'}"
					onclick={togglePause}
					data-testid="toggle-subscribe"
				>
					{subscribed ? 'Pause subscription' : `Resume subscription`}
				</button>
				<span class="text-xs opacity-60" data-testid="status">
					status: <strong>{subscribed ? 'subscribed' : 'paused'}</strong>
					{#if !subscribed}<span class="font-mono ml-2">({pausedFor()}s)</span>{/if}
				</span>
				<span class="ml-auto flex gap-2">
					<span class="badge badge-success badge-sm" data-testid="tier-live">live: {tierCounts.live}</span>
					<span class="badge badge-info badge-sm" data-testid="tier-rehydrate">rehydrate: {tierCounts.rehydrate}</span>
					<span class="badge badge-warning badge-sm" data-testid="tier-fromseq">fromSeq: {tierCounts.fromSeq}</span>
				</span>
			</div>
			<p class="text-xs opacity-60">
				Replay buffer covers up to {state.storeRetain} events
				(roughly {state.storeRetain} seconds at 1Hz). Pause longer
				than that to surface the <code>fromSeq</code> tier.
			</p>
		</div>
	</section>

	<!-- Events list -->
	<section class="card bg-base-100 border border-base-300" data-testid="events-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Events ({entries.length})</h2>
			{#if entries.length === 0}
				<p class="opacity-40 text-sm" data-testid="events-empty">no events yet</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono max-h-96 overflow-y-auto" data-testid="events-list">
					{#each entries as e (e.id)}
						<li class="flex items-center gap-2" data-testid="event-row">
							<span class="opacity-50 w-20">{timeOf(e.ts)}</span>
							<span class="opacity-50 w-12 text-right">#{e.seq}</span>
							<span class="badge badge-xs {tierBadgeClass(e.tier)}" data-testid={'event-tier-' + e.id}>{e.tier}</span>
							<span class="flex-1 truncate" data-testid="event-message">{e.message}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>live.stream(topic, loader, &#123; replay: true, delta: &#123; fromSeq &#125; &#125;)</code>.
			The loader returns the recent window tagged <code>rehydrate</code>;
			the cron's live publishes pick up the original <code>live</code>
			tag and ride the platform's replay buffer for short-gap
			coverage; <code>delta.fromSeq(sinceSeq)</code> reads from the
			durable store and tags missed entries <code>fromSeq</code>.
		</p>
		<p>
			Resolution chain on reconnect:
			<strong>1.</strong> bounded replay buffer (events tagged with
			whatever they were published as);
			<strong>2.</strong> <code>delta.fromSeq</code> (events tagged
			<code>fromSeq</code>);
			<strong>3.</strong> full rehydrate via the loader (events
			tagged <code>rehydrate</code>). The page renders each tier
			distinctly so you can see which path delivered each event.
		</p>
	</aside>
</div>
