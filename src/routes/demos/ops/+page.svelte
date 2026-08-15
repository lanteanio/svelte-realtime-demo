<!--
	/demos/ops: the introspection dashboard.

	One introspect() call, rendered as an ops panel: connections and
	in-flight work, topic load, handler counts by kind, push registry,
	the transport layer's admission/pressure posture, cron + reactive
	counters, and the outbound-webhook DLQ summary. Polled via the
	snapshot RPC on a 3s interval, but only while the tab is visible.

	One headline primitive: introspect() - counts-only, PII-free by
	design - plus a pointer card to the auth-gated /__realtime admin
	plane that serves the same snapshot over HTTP.
-->
<script>
	import { snapshot, dlqSummary } from '$live/demos/ops'
	import { NO_READING, ageReading, pressureState, reading, statReading } from '$lib/ops-readings'

	let { data } = $props()
	const me = $derived(data.identity)

	const POLL_MS = 3000

	let snap = $state(/** @type {any} */ (null))
	let dlq = $state(/** @type {any} */ (null))
	let refreshedAt = $state(0)
	let lastError = $state('')
	let inFlight = false

	async function refresh() {
		if (inFlight) return
		inFlight = true
		try {
			const [s, d] = await Promise.all([snapshot(), dlqSummary()])
			snap = s
			dlq = d
			refreshedAt = Date.now()
			lastError = ''
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			inFlight = false
		}
	}

	// Poll only while the tab is visible: no point burning RPCs on a
	// backgrounded dashboard. An immediate refresh fires on return to
	// visibility so the numbers never look 3s stale after a tab switch.
	$effect(() => {
		refresh()
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') refresh()
		}, POLL_MS)
		const onVisibility = () => {
			if (document.visibilityState === 'visible') refresh()
		}
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisibility)
		}
	})

	const pressure = $derived(snap?.transport?.pressure ?? null)
	// Aged by the worker that took the sample - see the RPC in ops.js for why
	// the browser must not do this subtraction itself.
	const pressureAgeMs = $derived(snap?.pressureAgeMs ?? null)
	const posture = $derived(pressureState(pressure, pressureAgeMs))
	const byKind = $derived(snap?.handlers?.byKind ?? null)
	const modifiers = $derived(snap?.handlers?.modifiers ?? null)
	const dlqTopics = $derived(Object.entries(dlq?.byTopic ?? {}))
	// Which worker answered this snapshot. introspect() is per-process, so on
	// the SO_REUSEPORT cluster each reconnect can land on a different replica
	// and the counts jump; the id makes that self-explanatory. null in
	// single-instance dev before the leader facade is active.
	const replica = $derived(snap?.replica ?? null)

	function fmtTs(ts) {
		return ts ? new Date(ts).toLocaleTimeString() : '-'
	}

	// Reading rules live in $lib/ops-readings so they can be unit-tested: the
	// pre-sample window they exist for is not reachable from a browser test
	// against a warm server, which has always sampled by the time the browser
	// looks.
	const stat = statReading
	const count = reading

	let copied = $state(false)
	let copyTimer = null
	const CURL = 'curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-host/__realtime/introspect'

	async function copyCurl() {
		try {
			await navigator.clipboard.writeText(CURL)
			copied = true
			clearTimeout(copyTimer)
			copyTimer = setTimeout(() => { copied = false }, 2000)
		} catch {
			// Clipboard access can be denied outright; say so rather than
			// showing a success state for something that did not happen.
			copied = false
		}
	}

	$effect(() => () => clearTimeout(copyTimer))

	// Match the cluster-cron page: the instanceId is a 16-hex string; show
	// the first 8 so the same worker reads the same in both demos.
	function shortId(id) {
		if (!id) return null
		return id.length <= 10 ? id : id.slice(0, 8) + '...'
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Ops: the introspection dashboard</h1>
		<p class="text-sm opacity-70 mt-1">
			One <code>introspect()</code> call returns the server's entire
			live dispatch state - counts only, PII-free by design (no user
			ids, no presence rosters, no handler paths, no topic names).
			This page polls it every 3 seconds while the tab is visible.
			The same snapshot is served over HTTP by the auth-gated admin
			plane described at the bottom.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Reading as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Headline counters -->
	<section class="card bg-base-200" data-testid="ops-headline-card">
		<div class="card-body py-3">
			<div class="flex items-center justify-between gap-2">
				<h2 class="card-title text-sm">Dispatch state</h2>
				<div class="flex items-center gap-2 text-xs opacity-50">
					{#if replica}
						<span
							data-testid="ops-replica"
							title="This introspect() read the local state of worker {replica}. On the multi-replica cluster each reconnect (F5) can land on a different worker, so the counts jump."
						>
							reading replica <span class="font-mono" data-instance-id={replica}>{shortId(replica)}</span>
						</span>
					{/if}
					<span data-testid="ops-refreshed-at">
						{refreshedAt ? `refreshed ${fmtTs(refreshedAt)}` : 'loading...'}
					</span>
				</div>
			</div>
			<dl class="grid grid-cols-2 @2xl:grid-cols-4 gap-3 text-xs mt-1">
				<div>
					<dt class="opacity-60">connections</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-connections">{count(snap?.transport?.connections)}</dd>
				</div>
				<div>
					<dt class="opacity-60">in flight</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-inflight">{count(snap?.inFlight)}</dd>
				</div>
				<div>
					<dt class="opacity-60">active topics</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-topics-active">{count(snap?.topics?.active)}</dd>
				</div>
				<div>
					<dt class="opacity-60">subscribers</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-topics-subscribers">{count(snap?.topics?.subscribers)}</dd>
				</div>
			</dl>
			{#if replica}
				<p class="text-xs opacity-50" data-testid="ops-replica-note">
					These are one worker's local counts. On a multi-replica
					deploy each reconnect can land on a different replica, so the
					numbers jump between refreshes - only the leader runs the
					crons, and connections/RSS are per-process. The replica id
					above tells you which worker answered.
				</p>
			{/if}
			{#if snap && !snap.transport}
				<p class="text-xs opacity-50" data-testid="ops-transport-missing">
					Transport snapshot unavailable (older adapter or before
					<code>init</code>) - connection count reads 0.
				</p>
			{/if}
			{#if lastError}
				<p class="text-xs text-error" data-testid="ops-error">{lastError}</p>
			{/if}
		</div>
	</section>

	<!-- @2xl, not @3xl: a 768px container rung engages at a 783px viewport, so
	     the old md: (768px viewport) intent was lost at exactly 768. -->
	<div class="grid @2xl:grid-cols-2 gap-4" data-testid="ops-columns">
		<!-- Handlers -->
		<section class="card bg-base-100 border border-base-300" data-testid="ops-handlers-card">
			<div class="card-body py-3 space-y-1">
				<h2 class="card-title text-sm">
					Handlers <span class="font-normal">(<span data-testid="ops-handlers-total">{count(snap?.handlers?.total)}</span>)</span>
				</h2>
				{#if byKind}
					<ul class="text-xs font-mono space-y-0.5" data-testid="ops-handlers-kinds">
						{#each Object.entries(byKind) as [kind, count] (kind)}
							<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
								<span class="opacity-60">{kind}</span>
								<span class="tabular-nums">{count}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-xs opacity-40">loading...</p>
				{/if}
				{#if modifiers}
					<p class="text-xs opacity-50 pt-1" data-testid="ops-handlers-modifiers">
						modifiers: deprecated {modifiers.deprecated} / rate-limited {modifiers.rateLimited}
						/ idempotent {modifiers.idempotent} / volatile {modifiers.volatile}
					</p>
				{/if}
			</div>
		</section>

		<!-- Push + cron + reactive -->
		<section class="card bg-base-100 border border-base-300" data-testid="ops-machinery-card">
			<div class="card-body py-3 space-y-1">
				<h2 class="card-title text-sm">Background machinery</h2>
				<!-- Two real columns, not a justified flex row: when the card
				     narrowed, both sides wrapped independently and a label's
				     tail ended up beside the previous row's value. A grid
				     keeps every value in its own column, and the values stay
				     on one line so a wrap can never interleave them. -->
				<ul class="text-xs font-mono space-y-0.5" data-testid="ops-machinery-rows">
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">push users / sessions</span>
						<span class="tabular-nums whitespace-nowrap"><span data-testid="ops-push-users">{count(snap?.push?.users)}</span> / <span data-testid="ops-push-sessions">{count(snap?.push?.sessions)}</span></span>
					</li>
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">cron jobs (running)</span>
						<span class="tabular-nums whitespace-nowrap" data-testid="ops-cron">{count(snap?.cron?.jobs)} ({count(snap?.cron?.running)})</span>
					</li>
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">derived / effect / aggregate</span>
						<span class="tabular-nums whitespace-nowrap" data-testid="ops-reactive">{count(snap?.reactive?.derived)} / {count(snap?.reactive?.effect)} / {count(snap?.reactive?.aggregate)}</span>
					</li>
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">watched topics</span>
						<span class="tabular-nums whitespace-nowrap" data-testid="ops-watched-topics">{count(snap?.reactive?.watchedTopics)}</span>
					</li>
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">rate-limit buckets</span>
						<span class="tabular-nums whitespace-nowrap" data-testid="ops-rate-buckets">{count(snap?.capacity?.rateLimitBuckets)}</span>
					</li>
					<li class="grid grid-cols-[1fr_auto] gap-x-3 items-baseline">
						<span class="opacity-60">metrics / admission wired</span>
						<span class="tabular-nums whitespace-nowrap" data-testid="ops-wired">{snap ? (snap.metrics ? 'yes' : 'no') : NO_READING} / {snap ? (snap.admission ? 'yes' : 'no') : NO_READING}</span>
					</li>
				</ul>
			</div>
		</section>
	</div>

	<!-- Admission / pressure -->
	<section class="card bg-base-100 border border-base-300" data-testid="ops-pressure-card">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Admission posture (transport)</h2>
			{#if posture === 'unsampled'}
				<!-- The snapshot exists but nothing in it has been measured: the
				     adapter populates every field with 0 at process start and
				     overwrites them on the first ~1Hz sampler fold. The panel used
				     to render those placeholders and single out RSS with a "no live
				     process weighs 0 MB" rule, which is true and covers exactly one
				     field - publish rate, buffered bytes and backpressured
				     connections are legitimately 0 on an idle worker, so the same
				     trick cannot reach them. sampledAt dates the snapshot, so one
				     branch withholds all of it. -->
				<p class="text-xs opacity-40" data-testid="ops-pressure-unsampled">
					Not sampled yet - the transport snapshot is present but the
					sampler has not folded, so every field is still its startup
					placeholder rather than a reading. Under <code>npm run dev</code>
					this is the permanent state: the dev plugin runs no sampler at
					all, so the dashboard shows the same state here that it must
					handle in production before the first tick.
				</p>
			{:else if pressure}
				<div class="flex items-center gap-3">
					<!-- The healthy state used to read "NONE" beside
					     "protection: normal", which binds to protection and
					     says the opposite of what it means. Name the state
					     itself instead of the absent reason field. -->
					<span
						class="badge {pressure.active ? 'badge-warning' : 'badge-success'}"
						data-testid="ops-pressure-reason"
					>{pressure.active ? (pressure.reason ?? 'under pressure') : 'no pressure'}</span>
					<progress
						class="progress progress-warning w-32"
						value={pressure.value ?? 0}
						max="1"
						data-testid="ops-pressure-value"
						title="composite pressure scalar (0..1)"
					></progress>
					<span class="text-xs opacity-60">
						protection: <span class="font-mono" data-testid="ops-protection">{snap?.transport?.protection ?? NO_READING}</span>
					</span>
				</div>
				<!-- Every number below is only as good as the fold that produced
				     it, so the panel says when that was. A sampler that stops
				     leaves real readings behind, which is neither "no data" nor
				     healthy; dating them is what tells the two apart, and it is the
				     same condition the pressure_sample_timestamp_seconds metric
				     alerts on. -->
				{#if posture === 'stale'}
					<p class="text-xs text-warning" data-testid="ops-sample-age" data-sample-age-ms={pressureAgeMs}>
						Sampler wedged: these readings are {ageReading(pressureAgeMs)}s
						old and the sampler folds about once a second. They were
						measured - just not recently.
					</p>
				{:else}
					<p class="text-xs opacity-50" data-testid="ops-sample-age" data-sample-age-ms={pressureAgeMs}>
						sampled {ageReading(pressureAgeMs)}s ago
					</p>
				{/if}
				<!-- Units live in the labels, so every value is a bare number
				     of the same shape and the four stats keep one baseline
				     even where the column is narrow. -->
				<dl class="grid grid-cols-2 @2xl:grid-cols-4 gap-2 text-xs items-baseline" data-testid="ops-posture-stats">
					<div>
						<dt class="opacity-60">publish/s</dt>
						<dd class="font-bold tabular-nums" data-testid="ops-publish-rate">{stat(pressure.publishRate)}</dd>
					</div>
					<div>
						<dt class="opacity-60">RSS MB</dt>
						<dd class="font-bold tabular-nums" data-testid="ops-memory-mb">{stat(pressure.memoryMB)}</dd>
					</div>
					{#if pressure.backpressuredConnections != null}
						<div>
							<dt class="opacity-60">backpressured</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-backpressured">{count(pressure.backpressuredConnections)}</dd>
						</div>
					{/if}
					{#if pressure.maxBufferedBytes != null}
						<div>
							<dt class="opacity-60">max buffered KB</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-max-buffered">{stat(pressure.maxBufferedBytes / 1024)}</dd>
						</div>
					{/if}
					<!-- Linux-only kernel signals; absent off-Linux and in dev. -->
					{#if pressure.psi != null}
						<div>
							<dt class="opacity-60">PSI cpu-some %</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-psi">{stat(pressure.psi.cpuSome10, 1)}</dd>
						</div>
					{/if}
					{#if pressure.cpuThrottle != null}
						<div>
							<dt class="opacity-60">CFS throttled %</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-cpu-throttle">{stat(typeof pressure.cpuThrottle.throttledRatio === 'number' ? pressure.cpuThrottle.throttledRatio * 100 : undefined)}</dd>
						</div>
					{/if}
				</dl>
			{:else}
				<p class="text-xs opacity-40" data-testid="ops-pressure-missing">
					No transport pressure snapshot on this platform.
				</p>
			{/if}
		</div>
	</section>

	<!-- DLQ summary -->
	<section class="card bg-base-100 border border-base-300" data-testid="ops-dlq-card">
		<div class="card-body py-3 space-y-1">
			<h2 class="card-title text-sm">
				Outbound-webhook DLQ <span class="font-normal">(<span data-testid="ops-dlq-total">{count(dlq?.total)}</span>)</span>
			</h2>
			{#if dlq === null}
				<p class="text-xs opacity-40" data-testid="ops-dlq-off">No dead-letter store configured.</p>
			{:else if dlqTopics.length === 0}
				<p class="text-xs opacity-40" data-testid="ops-dlq-empty">Empty - every delivery is getting through.</p>
			{:else}
				<table class="table table-xs" data-testid="ops-dlq-by-topic">
					<thead>
						<tr><th>topic</th><th class="text-right">records</th></tr>
					</thead>
					<tbody>
						{#each dlqTopics as [topic, count] (topic)}
							<tr data-testid="ops-dlq-topic-row">
								<td class="font-mono">{topic}</td>
								<td class="text-right tabular-nums">{count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="text-xs opacity-50">
					oldest {fmtTs(dlq?.oldest)} / newest {fmtTs(dlq?.newest)}
				</p>
			{/if}
			<p class="text-xs opacity-50">
				This is the counts-only summary. Inspection and replay live on
				<a class="link" href="/demos/outbound-webhooks">/demos/outbound-webhooks</a>.
			</p>
		</div>
	</section>

	<!-- Admin plane note -->
	<section class="card bg-base-200" data-testid="ops-admin-card">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">The authenticated admin plane</h2>
			<p class="text-xs opacity-70">
				The adapter auto-mounts <code>/__realtime/*</code> when
				<code>hooks.ws.js</code> exports the <code>admin</code> handler
				from <code>realtime(&#123; admin &#125;)</code>. It serves this
				same snapshot at <code>GET /__realtime/introspect</code>
				(plus <code>?handlers=true</code> / <code>?topics=true</code>
				for the structural opt-ins this public page deliberately never
				requests), the DLQ at <code>/__realtime/dlq</code>, and the
				pause-aware metrics lifeline at <code>/__realtime/metrics</code>.
				Fail-closed: every request runs the bearer check before any
				data is gathered; no token configured means nothing is ever
				admitted.
			</p>
			<!-- The one actionable artifact on the card was clipped mid-token
			     on phones with nothing signalling the rest existed. Copy makes
			     the whole line reachable without scrolling at all, and the
			     hint says the rest is there. -->
			<div class="flex items-start gap-2">
				<pre class="text-xs bg-base-300 rounded p-2 overflow-x-auto flex-1 min-w-0" data-testid="ops-curl"><code>{CURL}</code></pre>
				<button
					class="btn btn-sm btn-outline pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					onclick={copyCurl}
					data-testid="ops-curl-copy"
				>
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>
			<p class="text-xs opacity-70" data-testid="ops-curl-hint">
				The line scrolls sideways on narrow screens - Copy takes the whole command.
			</p>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>snapshot = live(async () =&gt; introspect())</code> -
			a pure, cheap read over in-memory registry sizes, safe to poll.
			It is counts-only and PII-free by design, which is why this page
			can expose it to any visitor; the <code>&#123; handlers: true,
			topics: true &#125;</code> opt-ins (handler paths, topic names)
			stay behind the bearer-gated admin route. The DLQ card reads
			<code>getDeadLetter()?.summary()</code> - the Redis-backed
			cluster-shared store wired via <code>configureWebhooks</code>.
			See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/ops.js">ops.js</a>.
		</p>
		<p>
			Client: no stream, no cron - the page polls the RPC on a 3s
			interval gated on <code>document.visibilityState</code>, so a
			backgrounded tab costs nothing. Push beats poll for app data;
			an ops readout you only look at while looking at it is the
			honest exception.
		</p>
	</aside>
</div>
