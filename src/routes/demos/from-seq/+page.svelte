<!--
	/demos/from-seq: two reconnect ladders, a replay buffer and delta.fromSeq.

	A 1Hz cron publishes numbered events. The page renders received events
	with a tier badge: `rehydrate` (loader), `live` (cron tick during your
	subscription), or `fromSeq` (gap-fill through the `delta.fromSeq(sinceSeq)`
	bridge).

	Click Pause to drop the subscription; the cron keeps publishing. Click
	Resume to subscribe again. The default stream declares a replay buffer:
	a short gap fills from it (events keep their original `live` tag and get
	a replay badge), and a gap longer than the buffer reloads through the
	loader. The fromSeq stream declares no buffer: its gap fills from the
	durable store through `delta.fromSeq`, tagged `fromSeq`. A stream
	resumes one way or the other, never both.
-->
<script>
	import { onMount, untrack } from 'svelte'
	import { SvelteSet } from 'svelte/reactivity'
	import { status } from 'svelte-adapter-uws/client'
	import {
		myFromSeqState,
		eventStream,
		eventStreamFast
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
	let fastPath = $state(false)
	let fastPathReady = $state(false)
	// Live events seen since the fromSeq stream was selected. A local count, not a
	// timestamp comparison, so the gate cannot depend on client/server clock
	// agreement. Not $state: it is only ever read to set fastPathReady.
	let liveSinceArm = 0

	// Replay-buffer gap-fill detection. The framework delivers buffered
	// events with their ORIGINAL `tier: 'live'` tag, indistinguishable
	// on the wire from real-time ticks. To make that fill visible in the
	// UI we capture (pausedAtSeq, resumedAt) on each pause/resume cycle
	// and locally tag any incoming event whose seq overshoots
	// pausedAtSeq AND whose server-side ts predates the resume as
	// replay-buffer fill. Pure UI - the server data is unchanged.
	let pausedAtSeq = $state(0)
	let resumedAt = $state(0)
	let replayFillSeqs = new SvelteSet()
	let replayBurstCount = $state(0)
	// Server clock minus browser clock, estimated from live events as they
	// arrive: the largest `e.ts - Date.now()` seen is the offset less the
	// smallest delivery latency. Replayed events are old, so they never raise
	// it. Replay-fill detection reads the resume time on the server's clock
	// through this, so a browser clock that runs ahead or behind cannot turn
	// live ticks into fill or fill into live ticks.
	let serverClockOffset = null

	// Merge incoming SDK values into the local display list by id rather
	// than replacing wholesale. Without this, a pause+resume cycle that
	// clears the SDK's cached value mid-flight clobbers the page's
	// history to [] on the first callback firing of the resubscribe,
	// even though the wire-level gap-fill (replay buffer / fromSeq)
	// delivers the missed entries a moment later. By merging we preserve
	// the older rows the user has already seen and stamp the new ones
	// with whatever tier the server tagged them.
	//
	// The callback body runs under untrack() because the SDK's store fires
	// synchronously on subscribe with its current value -- which during
	// the resume-grace window is the retained array from the previous
	// session. Without untrack, that synchronous fire happens inside the
	// effect's tracking phase, the read of `entries` taints the effect,
	// the subsequent write triggers a re-run, and Svelte aborts with
	// effect_update_depth_exceeded.
	$effect(() => {
		if (!subscribed) return
		const stream = fastPath ? eventStreamFast : eventStream
		// Captured per subscription, so a straggler delivered from the previous
		// stream between the toggle and this effect's teardown cannot merge a
		// foreign sequence domain into the freshly cleared list.
		const armed = fastPath
		const off = stream.subscribe((v) => {
			untrack(() => {
				const arr = Array.isArray(v) ? v : []
				if (arr.length === 0) return
				if (armed !== fastPath) return
				const merged = new Map(entries.map((e) => [e.id, e]))
				for (const e of arr) {
					merged.set(e.id, e)
					// Arm on a live event ARRIVING, counted locally. Comparing the
					// server-stamped `e.ts` against a browser Date.now() gates the
					// whole feature on the two clocks agreeing: a client running
					// even slightly fast never arms, and the Pause button stays
					// disabled forever with no way to diagnose it.
					if (armed && e.tier === 'live') liveSinceArm++
					if (armed && liveSinceArm > 0) fastPathReady = true
					if (e.tier === 'live') {
						const offset = e.ts - Date.now()
						if (serverClockOffset === null || offset > serverClockOffset) serverClockOffset = offset
					}
					// Only the default stream has a replay buffer to fill from.
					if (
						!armed &&
						resumedAt > 0 &&
						serverClockOffset !== null &&
						e.tier === 'live' &&
						e.seq > pausedAtSeq &&
						e.ts < resumedAt + serverClockOffset
					) {
						if (!replayFillSeqs.has(e.seq)) {
							replayFillSeqs.add(e.seq)
							replayBurstCount++
						}
					}
				}
				entries = [...merged.values()].sort((a, b) => b.seq - a.seq)
			})
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
			pausedAtSeq = entries.length > 0 ? entries[0].seq : 0
			subscribed = false
			pausedAt = Date.now()
			replayBurstCount = 0
		} else {
			subscribed = true
			pausedAt = null
			resumedAt = Date.now()
		}
	}

	function toggleFastPath() {
		if (!subscribed) return
		fastPath = !fastPath
		// The two streams use independent sequence domains; reset the
		// rendered projection when switching so equal sequence numbers from
		// the two domains cannot look duplicated.
		entries = []
		replayFillSeqs.clear()
		pausedAtSeq = 0
		liveSinceArm = 0
		fastPathReady = false
		resumedAt = 0
		replayBurstCount = 0
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

	// Banner stays up for 5s after resume so a user who looked away
	// catches the gap-fill confirmation.
	const showReplayBanner = $derived(
		subscribed &&
		resumedAt > 0 &&
		replayBurstCount > 0 &&
		(nowMs - resumedAt) < 5000
	)

	// Live countdown while paused: how many more seconds until the gap
	// outruns the replay buffer and the resume reloads through the loader.
	const fromSeqHint = $derived.by(() => {
		if (subscribed) return null
		const elapsed = pausedFor()
		const remaining = state.storeRetain - elapsed
		if (remaining > 0) {
			return `Pause ${remaining}s more (${remaining + elapsed}s total) to outrun the replay buffer; resuming then reloads through the loader.`
		}
		return `Buffer outrun (${elapsed}s paused). Resume reloads the recent window through the loader.`
	})

	function timeOf(ts) {
		return new Date(ts).toLocaleTimeString()
	}

	// The rows carry their seq in a dedicated column; the message repeats it
	// on the wire, so strip the suffix for display only.
	function messageKind(m) {
		return String(m ?? '').replace(/\s#\d+$/, '')
	}

	// "subscribed" is only claimed when the connection is up and data has
	// actually arrived; a client-side toggle alone proves nothing offline.
	const displayStatus = $derived(
		!subscribed ? 'paused'
		: $status === 'open' || $status === 'suspended'
			? (entries.length === 0 ? 'subscribing...' : 'subscribed')
			: 'reconnecting'
	)
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="page-title mt-2">Reconnect: replay buffer or delta.fromSeq gap fill</h1>
		<p class="text-sm opacity-70 mt-1">
			A 1Hz <code>live.cron</code> publishes numbered events and each row's
			badge names the path that delivered it. Pause, wait, then resume:
			the default stream fills short gaps from its replay buffer, and the
			fromSeq stream fills them from the durable store through
			<code>delta.fromSeq</code>. Gaps older than either reload through
			the loader.
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
				<!-- Neutral action hues: success/info/warning stay reserved for tier semantics. -->
				<button
					class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 {subscribed ? 'btn-outline btn-primary' : 'btn-primary'}"
					onclick={togglePause}
					disabled={fastPath && subscribed && !fastPathReady}
					data-testid="toggle-subscribe"
				>
					{subscribed ? 'Pause subscription' : `Resume subscription`}
				</button>
				<button
					class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 {fastPath ? 'btn-primary' : 'btn-outline'}"
					onclick={toggleFastPath}
					disabled={!subscribed}
					aria-pressed={fastPath}
					data-testid="fromseq-fast-path"
				>
					{fastPath ? 'fromSeq stream' : 'Use the fromSeq stream'}
				</button>
				<span class="text-xs opacity-60" data-testid="status">
					status: <strong>{displayStatus}</strong>
					{#if !subscribed}<span class="font-mono ml-2">({pausedFor()}s)</span>{/if}
				</span>
				<span class="ml-auto flex flex-wrap justify-end gap-2">
					<span class="badge badge-success badge-sm whitespace-nowrap" data-testid="tier-live">live: {tierCounts.live}</span>
					<span class="badge badge-info badge-sm whitespace-nowrap" data-testid="tier-rehydrate">rehydrate: {tierCounts.rehydrate}</span>
					<span class="badge badge-warning badge-sm whitespace-nowrap" data-testid="tier-fromseq">fromSeq: {tierCounts.fromSeq}</span>
					{#if replayFillSeqs.size > 0}
						<span class="badge badge-secondary badge-sm whitespace-nowrap" data-testid="tier-replay">replay: {replayFillSeqs.size}</span>
					{/if}
				</span>
			</div>
			<!-- One visible mapping from delivery path to on-row tag, in rest state. -->
			<p class="text-xs opacity-70" data-testid="tier-legend">
				replay buffer &rarr; <span class="badge badge-success badge-xs">live</span>
				+ <span class="badge badge-secondary badge-xs">replay</span> badge;
				durable bridge &rarr; <span class="badge badge-warning badge-xs">fromSeq</span>;
				loader &rarr; <span class="badge badge-info badge-xs">rehydrate</span>
			</p>
			{#if fastPath}
				<p class="text-xs opacity-70" data-testid="fromseq-fast-hint">
					{#if !fastPathReady && subscribed}
						Waiting for the first live event so the fromSeq stream has a resume cursor...
					{:else if !subscribed}
						fromSeq stream paused. Wait at least 2 seconds, then resume; the missed events come from the durable store through <code>delta.fromSeq</code>.
					{:else}
						fromSeq stream ready. Pause for 2 seconds, then resume to see the gap fill tagged <code>fromSeq</code>.
					{/if}
				</p>
			{:else if fromSeqHint}
				<p class="text-xs opacity-70" data-testid="fromseq-hint">{fromSeqHint}</p>
			{:else}
				<p class="text-xs opacity-60">
					Replay buffer covers up to {state.storeRetain} events
					(roughly {state.storeRetain} seconds at 1Hz); a longer pause
					reloads through the loader. Switch to the fromSeq stream to
					fill gaps through <code>delta.fromSeq</code>.
				</p>
			{/if}
		</div>
	</section>

	{#if showReplayBanner}
		<div class="alert alert-info py-2 text-sm" data-testid="replay-banner">
			Filled <strong>{replayBurstCount}</strong> event{replayBurstCount === 1 ? '' : 's'}
			from the replay buffer. Server-side <code>tier: 'live'</code> is preserved;
			the <span class="badge badge-secondary badge-xs">replay</span> badge below marks
			which rows arrived via gap-fill rather than real-time.
		</div>
	{/if}

	<!-- Events list -->
	<section class="card bg-base-100 border border-base-300" data-testid="events-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="section-title card-title">Events ({entries.length})</h2>
			{#if entries.length === 0}
				<p class="opacity-40 text-sm" data-testid="events-empty">no events yet</p>
			{:else}
				<!--
					The bounded scroller only exists where it cannot capture a page
					scroll: a wide container AND a fine pointer. overscroll-contain
					alone was not enough - it stops the scroll chaining to the page
					but leaves a swipe over the list scrolling history instead of the
					page, with nothing on screen saying so.

					Both conditions matter. Narrow is the reported case, but a touch
					tablet is wide and still traps the swipe, so the pointer test is
					what actually removes the trap; the width test is what keeps a
					desktop window from growing an unbounded list. Where neither
					holds, the list flows and the page owns scrolling.
				-->
				<ul class="space-y-1 text-xs font-mono @2xl:pointer-fine:max-h-96 @2xl:pointer-fine:overflow-y-auto @2xl:pointer-fine:overscroll-contain" data-testid="events-list">
					{#each entries as e (e.id)}
						<li class="flex items-center gap-2" data-testid="event-row">
							<span class="opacity-50 w-20" data-testid="event-time" data-ts={e.ts}>{timeOf(e.ts)}</span>
							<span class="opacity-50 w-12 text-right">#{e.seq}</span>
							<span class="badge badge-xs {tierBadgeClass(e.tier)}" data-testid={'event-tier-' + e.id}>{e.tier}</span>
							{#if replayFillSeqs.has(e.seq)}
								<span class="badge badge-xs badge-secondary" data-testid={'event-replay-' + e.id}>replay</span>
							{/if}
							<span class="flex-1 truncate" data-testid="event-message">{messageKind(e.message)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Default stream:
			<code>live.stream(topic, loader, &#123; replay: true &#125;)</code>.
			On resume, a gap the bounded replay buffer still covers is replayed
			(events keep the <code>live</code> tag they were published with);
			a longer gap reloads the recent window through the loader, tagged
			<code>rehydrate</code>.
		</p>
		<p>
			fromSeq stream:
			<code>live.stream(topic, loader, &#123; delta: &#123; fromSeq &#125; &#125;)</code>,
			published with <code>&#123; seq &#125;</code> from the durable store's
			own counter. On resume, <code>delta.fromSeq(sinceSeq)</code> reads
			the missed events from that store and tags them <code>fromSeq</code>;
			a gap older than the store reloads through the loader.
		</p>
		<p>
			A stream resumes from its buffer or through <code>delta.fromSeq</code>,
			never both. The page renders each tag distinctly so you can see which
			path delivered each event.
		</p>
	</aside>
</div>
