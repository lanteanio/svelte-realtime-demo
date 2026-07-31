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
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-connections">{snap?.transport?.connections ?? 0}</dd>
				</div>
				<div>
					<dt class="opacity-60">in flight</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-inflight">{snap?.inFlight ?? 0}</dd>
				</div>
				<div>
					<dt class="opacity-60">active topics</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-topics-active">{snap?.topics?.active ?? 0}</dd>
				</div>
				<div>
					<dt class="opacity-60">subscribers</dt>
					<dd class="font-bold tabular-nums text-lg" data-testid="ops-topics-subscribers">{snap?.topics?.subscribers ?? 0}</dd>
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

	<div class="grid @3xl:grid-cols-2 gap-4">
		<!-- Handlers -->
		<section class="card bg-base-100 border border-base-300" data-testid="ops-handlers-card">
			<div class="card-body py-3 space-y-1">
				<h2 class="card-title text-sm">
					Handlers <span class="font-normal">(<span data-testid="ops-handlers-total">{snap?.handlers?.total ?? 0}</span>)</span>
				</h2>
				{#if byKind}
					<ul class="text-xs font-mono space-y-0.5" data-testid="ops-handlers-kinds">
						{#each Object.entries(byKind) as [kind, count] (kind)}
							<li class="flex justify-between">
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
				<ul class="text-xs font-mono space-y-0.5">
					<li class="flex justify-between">
						<span class="opacity-60">push users / sessions</span>
						<span class="tabular-nums"><span data-testid="ops-push-users">{snap?.push?.users ?? 0}</span> / <span data-testid="ops-push-sessions">{snap?.push?.sessions ?? 0}</span></span>
					</li>
					<li class="flex justify-between">
						<span class="opacity-60">cron jobs (running)</span>
						<span class="tabular-nums" data-testid="ops-cron">{snap?.cron?.jobs ?? 0} ({snap?.cron?.running ?? 0})</span>
					</li>
					<li class="flex justify-between">
						<span class="opacity-60">derived / effect / aggregate</span>
						<span class="tabular-nums" data-testid="ops-reactive">{snap?.reactive?.derived ?? 0} / {snap?.reactive?.effect ?? 0} / {snap?.reactive?.aggregate ?? 0}</span>
					</li>
					<li class="flex justify-between">
						<span class="opacity-60">watched topics</span>
						<span class="tabular-nums" data-testid="ops-watched-topics">{snap?.reactive?.watchedTopics ?? 0}</span>
					</li>
					<li class="flex justify-between">
						<span class="opacity-60">rate-limit buckets</span>
						<span class="tabular-nums" data-testid="ops-rate-buckets">{snap?.capacity?.rateLimitBuckets ?? 0}</span>
					</li>
					<li class="flex justify-between">
						<span class="opacity-60">metrics / admission wired</span>
						<span class="tabular-nums" data-testid="ops-wired">{snap?.metrics ? 'yes' : 'no'} / {snap?.admission ? 'yes' : 'no'}</span>
					</li>
				</ul>
			</div>
		</section>
	</div>

	<!-- Admission / pressure -->
	<section class="card bg-base-100 border border-base-300" data-testid="ops-pressure-card">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Admission posture (transport)</h2>
			{#if pressure}
				<div class="flex items-center gap-3">
					<span
						class="badge {pressure.active ? 'badge-warning' : 'badge-success'}"
						data-testid="ops-pressure-reason"
					>{pressure.reason ?? 'NONE'}</span>
					<progress
						class="progress progress-warning w-32"
						value={pressure.value ?? 0}
						max="1"
						data-testid="ops-pressure-value"
						title="composite pressure scalar (0..1)"
					></progress>
					<span class="text-xs opacity-60">
						protection: <span class="font-mono" data-testid="ops-protection">{snap?.transport?.protection ?? '-'}</span>
					</span>
				</div>
				<dl class="grid grid-cols-2 @2xl:grid-cols-4 gap-2 text-xs">
					<div>
						<dt class="opacity-60">publish/s</dt>
						<dd class="font-bold tabular-nums" data-testid="ops-publish-rate">{(pressure.publishRate ?? 0).toFixed(0)}</dd>
					</div>
					<div>
						<dt class="opacity-60">RSS MB</dt>
						<dd class="font-bold tabular-nums" data-testid="ops-memory-mb">{(pressure.memoryMB ?? 0).toFixed(0)}</dd>
					</div>
					{#if pressure.backpressuredConnections != null}
						<div>
							<dt class="opacity-60">backpressured</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-backpressured">{pressure.backpressuredConnections}</dd>
						</div>
					{/if}
					{#if pressure.maxBufferedBytes != null}
						<div>
							<dt class="opacity-60">max buffered</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-max-buffered">{((pressure.maxBufferedBytes ?? 0) / 1024).toFixed(0)}KB</dd>
						</div>
					{/if}
					<!-- Linux-only kernel signals; absent off-Linux and in dev. -->
					{#if pressure.psi != null}
						<div>
							<dt class="opacity-60">PSI cpu-some</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-psi">{(pressure.psi.cpuSome10 ?? 0).toFixed(1)}%</dd>
						</div>
					{/if}
					{#if pressure.cpuThrottle != null}
						<div>
							<dt class="opacity-60">CFS throttled</dt>
							<dd class="font-bold tabular-nums" data-testid="ops-cpu-throttle">{((pressure.cpuThrottle.throttledRatio ?? 0) * 100).toFixed(0)}%</dd>
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
				Outbound-webhook DLQ <span class="font-normal">(<span data-testid="ops-dlq-total">{dlq?.total ?? 0}</span>)</span>
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
			<pre class="text-xs bg-base-300 rounded p-2 overflow-x-auto" data-testid="ops-curl"><code>curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-host/__realtime/introspect</code></pre>
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
