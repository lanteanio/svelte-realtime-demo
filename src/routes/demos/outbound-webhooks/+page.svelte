<!--
	/demos/outbound-webhooks: the delivery pipeline, DLQ, and replay.

	Place order -> ctx.publish on the orders topic -> the outbound
	webhook (leader-gated) POSTs a signed body to the in-app sink ->
	the sink verifies the HMAC and logs a receipt. Place a FAILING
	order and the sink answers 500, the sender retries with backoff,
	and the event dead-letters into the cluster-shared Redis DLQ,
	where each record can be replayed.

	One headline primitive: live.webhooks.outbound(sources, config) -
	plus getDeadLetter() / replayDeadLetter() for the failure half.
-->
<script>
	import { placeOrder, recentReceipts, deadLetters, replayOrders } from '$live/demos/outbound-webhooks'

	let { data } = $props()
	const me = $derived(data.identity)

	const POLL_MS = 3000

	let receipts = $state(/** @type {any[]} */ ([]))
	let dlqRows = $state(/** @type {any[]} */ ([]))
	let lastOrder = $state(/** @type {{ id: string, mode: string } | null} */ (null))
	let lastReplay = $state(/** @type {{ replayed: number, total: number } | null} */ (null))
	let lastError = $state('')
	let placing = $state(false)
	let replaying = $state(false)
	let polling = false

	async function refresh() {
		if (polling) return
		polling = true
		try {
			const [r, d] = await Promise.all([recentReceipts(), deadLetters()])
			receipts = Array.isArray(r) ? r : []
			dlqRows = Array.isArray(d) ? d : []
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			polling = false
		}
	}

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

	async function handlePlace(mode) {
		if (placing) return
		placing = true
		lastError = ''
		try {
			const order = await placeOrder(mode)
			lastOrder = { id: order?.id ?? '', mode: order?.mode ?? mode }
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			placing = false
		}
	}

	async function handleReplay(ids) {
		if (replaying) return
		replaying = true
		lastError = ''
		try {
			const result = await replayOrders(ids)
			lastReplay = { replayed: result?.replayed ?? 0, total: result?.total ?? 0 }
			await refresh()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			replaying = false
		}
	}

	function fmtTs(ts) {
		return ts ? new Date(ts).toLocaleTimeString() : '-'
	}
	function shortId(id) {
		return typeof id === 'string' ? id.slice(0, 8) : '-'
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Outbound webhooks: sign, retry, dead-letter, replay</h1>
		<p class="text-sm opacity-70 mt-1">
			<code>live.webhooks.outbound(['demos:outbound:orders'], ...)</code>
			POSTs a signed body to a sink endpoint on every publish - no
			<code>+server.js</code> on the sending side, no client code.
			Place an order and watch the receipt arrive with its verified
			HMAC signature and <code>idempotency-key</code>; place a
			<em>failing</em> order and watch the retries exhaust into the
			cluster-shared dead-letter queue, then replay it.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Ordering as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Controls -->
	<section class="card bg-base-200" data-testid="ow-controls-card">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Place an order</h2>
			<div class="flex flex-wrap gap-2 items-center">
				<button class="btn btn-sm btn-primary" onclick={() => handlePlace('ok')} disabled={placing} data-testid="ow-place-ok">
					Place order
				</button>
				<button class="btn btn-sm btn-warning" onclick={() => handlePlace('fail')} disabled={placing} data-testid="ow-place-fail">
					Place failing order
				</button>
				{#if lastOrder}
					<span class="text-xs opacity-70" data-testid="ow-last-order">
						placed <span class="font-mono">{shortId(lastOrder.id)}</span>
						<span class="badge badge-xs {lastOrder.mode === 'fail' ? 'badge-warning' : 'badge-success'}">{lastOrder.mode}</span>
					</span>
				{/if}
			</div>
			{#if lastError}
				<p class="text-xs text-error" data-testid="ow-error">{lastError}</p>
			{/if}
			<p class="text-xs opacity-60">
				Both buttons just <code>ctx.publish</code> a
				<code>placed</code> event - the webhook declaration does the
				rest. A failing order asks the sink to answer 500, so the
				delivery retries (300 / 600 / 1200ms, jittered) and then
				dead-letters.
			</p>
		</div>
	</section>

	<!-- Receipts -->
	<section class="card bg-base-100 border border-base-300 min-h-[10rem]" data-testid="ow-receipts-card">
		<div class="card-body py-3 space-y-1">
			<h2 class="card-title text-sm">
				Sink receipts <span class="font-normal">(<span data-testid="ow-receipts-count">{receipts.length}</span>)</span>
			</h2>
			<ul class="text-xs font-mono space-y-1" data-testid="ow-receipts">
				{#each receipts as r, i (r.at + ':' + i)}
					<li class="flex flex-wrap items-center gap-2" data-testid="ow-receipt-row">
						<span class="opacity-60 w-20">{fmtTs(r.at)}</span>
						<span class="badge badge-ghost badge-xs">{r.event ?? '?'}</span>
						<span class="opacity-80" data-testid="ow-receipt-order">{shortId(r.orderId)}</span>
						<span class="badge badge-xs {r.status === 200 ? 'badge-success' : 'badge-error'}">{r.status}</span>
						{#if r.sigValid}
							<span class="badge badge-success badge-xs" data-testid="ow-sig-valid">sig ok</span>
						{:else}
							<span class="badge badge-error badge-xs" data-testid="ow-sig-invalid">sig bad</span>
						{/if}
						<span class="opacity-50 truncate" title="idempotency-key" data-testid="ow-idem-key">idem: {shortId(r.idempotencyKey)}</span>
					</li>
				{:else}
					<li class="opacity-40 text-center py-4" data-testid="ow-receipts-empty">No deliveries yet. Place an order.</li>
				{/each}
			</ul>
			<p class="text-xs opacity-50">
				Newest first, polled every 3s while visible. The sink is a
				plain HTTP route with no live ctx - it verifies the signature,
				logs the receipt to Redis, and answers; honest polling instead
				of a pretend push. Retried deliveries repeat the same
				idempotency key - that repetition is the at-least-once
				contract made visible.
			</p>
		</div>
	</section>

	<!-- DLQ -->
	<section class="card bg-base-100 border border-base-300 min-h-[8rem]" data-testid="ow-dlq-card">
		<div class="card-body py-3 space-y-1">
			<div class="flex items-center justify-between">
				<h2 class="card-title text-sm">
					Dead-letter queue <span class="font-normal">(<span data-testid="ow-dlq-count">{dlqRows.length}</span>)</span>
				</h2>
				<button
					class="btn btn-xs btn-ghost"
					onclick={() => handleReplay(undefined)}
					disabled={replaying || dlqRows.length === 0}
					data-testid="ow-replay-all"
				>
					{replaying ? 'Replaying...' : 'Replay all'}
				</button>
			</div>
			<ul class="text-xs font-mono space-y-1" data-testid="ow-dlq">
				{#each dlqRows as r (r.id)}
					<li class="flex flex-wrap items-center gap-2" data-testid="ow-dlq-row">
						<span class="opacity-60 w-20">{fmtTs(r.failedAt)}</span>
						<span class="badge badge-ghost badge-xs">{r.event}</span>
						<span class="opacity-80">{shortId(r.orderId)}</span>
						<span class="badge badge-warning badge-xs">{r.mode}</span>
						<span class="opacity-60">attempts: {r.attempts}</span>
						<span class="opacity-50 truncate flex-1" title={r.error}>{r.error}</span>
						<button
							class="btn btn-xs btn-outline"
							onclick={() => handleReplay([r.id])}
							disabled={replaying}
							data-testid="ow-replay"
						>
							Replay
						</button>
					</li>
				{:else}
					<li class="opacity-40 text-center py-4" data-testid="ow-dlq-empty">Empty. Place a failing order to fill it.</li>
				{/each}
			</ul>
			{#if lastReplay}
				<p class="text-xs opacity-70" data-testid="ow-replay-result">
					replayed {lastReplay.replayed} of {lastReplay.total}
				</p>
			{/if}
			<p class="text-xs opacity-50">
				Replay re-fires the ORIGINAL payload through the complete
				delivery path (SSRF gate re-applied, signature and idempotency
				key recomputed) - that is the point. So replaying a
				<code>fail</code> order fails again and returns here, exactly
				like a receiver that is still down; in a real incident you fix
				the endpoint, then replay.
			</p>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>orderEvents = live.webhooks.outbound(['demos:outbound:orders'],
			&#123; url, secret, urlMode: 'off', validateUrl, retry, timeoutMs,
			idempotencyKey &#125;)</code>. The sink is same-host loopback -
			exactly what the default SSRF guard blocks - so the config uses
			the documented self-target recipe: <code>urlMode: 'off'</code>
			relaxes the range check (scheme gate and DNS pinning stay on)
			and <code>validateUrl</code> narrows delivery back down to
			exactly <code>/api/demos/webhook-sink</code> on every hop. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/outbound-webhooks.js">outbound-webhooks.js</a>.
		</p>
		<p>
			Each delivery is signed with a timestamped HMAC-SHA256:
			<code>x-webhook-signature: sha256=&lt;hex&gt;</code> over
			<code>&lt;x-webhook-timestamp&gt;.&lt;body&gt;</code>, so a
			captured delivery stops verifying once the freshness window
			passes (the sink verifies with the package's own
			<code>verifyWebhookSignature</code>: timing-safe,
			rotation-ready via comma-separated entries). Delivery is at-least-once with a stable
			<code>idempotency-key</code>; the retry budget, endpoint breaker,
			and dead-letter store are Redis-backed and fleet-shared via
			<code>configureWebhooks</code>, and <code>configureCron(&#123;
			leader &#125;)</code> gates firing to one replica. The DLQ
			counts also appear on <a class="link" href="/demos/ops">/demos/ops</a>
			and behind the admin plane at <code>GET /__realtime/dlq</code>.
		</p>
	</aside>
</div>
