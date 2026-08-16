<!--
	/demos/checkout - idempotency demo.

	Two buttons:
	- "Place Order" generates a fresh idempotencyKey per click.
	  Each click is a different intent; counter increments.
	- "Retry x5 (same key)" fires 5 RPCs in rapid succession with
	  the SAME idempotencyKey. Only the FIRST increments the counter;
	  the other four return the cached result. Watch the network tab:
	  5 requests, 1 effect.

	The history list shows each RPC's intent UUID and the count it
	returned, so you can see retries hit the same value.
-->
<script>
	import { count, placeOrder, reset } from '$live/demos/checkout'
	import { confirmDestructive } from '$lib/confirm-destructive'

	let history = $state([])
	let busy = $state(false)

	async function fireOne() {
		if (busy) return
		busy = true
		const idempotencyKey = crypto.randomUUID()
		try {
			const r = await placeOrder.with({ idempotencyKey })()
			history = [{ key: idempotencyKey, count: r.count, label: 'fresh' }, ...history].slice(0, 12)
		} finally {
			busy = false
		}
	}

	async function fireFive() {
		if (busy) return
		busy = true
		const idempotencyKey = crypto.randomUUID()
		try {
			const calls = Array.from({ length: 5 }, () => placeOrder.with({ idempotencyKey })())
			const results = await Promise.all(calls)
			const entries = results.map((r, i) => ({
				key: idempotencyKey,
				count: r.count,
				label: i === 0 ? 'first (effect)' : `retry ${i} (cached)`
			}))
			history = [...entries.reverse(), ...history].slice(0, 12)
		} finally {
			busy = false
		}
	}

	async function handleReset() {
		if (busy) return
		if (!confirmDestructive('Reset the checkout counter and history?')) return
		await reset()
		history = []
	}
</script>

<div class="max-w-2xl mx-auto p-8 space-y-6">
	<header>

		<h1 class="text-2xl font-bold mt-2">Idempotency under a retry storm</h1>
		<p class="text-sm opacity-70 mt-1">
			Click "Retry x5 (same key)" to fire five rapid RPCs with the same
			idempotencyKey. Only the first runs the handler; the other four
			return the cached result. One intent, one effect.
		</p>
		<!-- The page used to promise "under double-click" and then absorb a
		     real double-click in a disabled button, so what a visitor could
		     actually perform was defended by the UI rather than by the
		     primitive. Naming the lockout is the honest system image: the
		     button below is the demonstration, and the disabling is not the
		     guarantee. -->
		<p class="text-sm opacity-70 mt-1" data-testid="checkout-lockout-note">
			Both buttons disable while a call is in flight, so a literal
			double-click is stopped by the page before it reaches the server -
			that is UI lockout, not idempotency. The burst above is the honest
			demonstration: five real overlapping RPCs the client never
			suppressed, deduped by their shared key on the server.
		</p>
	</header>

	<div class="card bg-base-200 shadow">
		<div class="card-body items-center text-center py-10">
			<div class="text-sm opacity-60">Total orders placed</div>
			<div class="text-7xl font-bold tabular-nums" data-testid="checkout-count" data-hydrated={$count !== undefined}>{$count ?? 0}</div>
		</div>
	</div>

	<!-- Retry leads, in position and in weight. The copy above instructs this
	     button, and it is the one that shows the page's whole point (five RPCs,
	     one effect) - but it used to sit second in a warning style beside a
	     primary Place Order, so the click magnet was the control case, which
	     increments the counter and demonstrates nothing about idempotency. A
	     visitor could click, get feedback, and leave having seen none of it. -->
	<div class="flex flex-wrap gap-3 justify-center">
		<button class="btn btn-primary" onclick={fireFive} disabled={busy} data-testid="checkout-retry">
			Retry x5 (same key)
		</button>
		<button class="btn btn-outline" onclick={fireOne} disabled={busy} data-testid="checkout-place">
			Place Order
		</button>
		<button class="btn btn-outline btn-error" onclick={handleReset} disabled={busy} data-testid="checkout-reset">Reset</button>
	</div>

	{#if history.length > 0}
		<div class="card bg-base-100 border border-base-300">
			<div class="card-body py-4">
				<h2 class="card-title text-sm">RPC history (newest first)</h2>
				<ul class="text-xs space-y-1 font-mono" data-testid="checkout-history">
					<!-- Keyed on content alone. The index used to be part of the key,
				     so every prepend re-keyed every existing row and the whole
				     list was destroyed and rebuilt on each burst - which is the
				     opposite of what a keyed each is for. The pair is already
				     unique within one list: a burst's five rows share one
				     idempotency key and carry distinct labels, and a fresh order
				     brings its own key. -->
				{#each history as entry (entry.key + entry.label)}
						<li class="flex justify-between gap-3" data-testid="checkout-history-row">
							<span class="opacity-60 truncate max-w-[18ch]" title={entry.key}>{entry.key.slice(0, 8)}...</span>
							<span class="opacity-60" data-testid="checkout-history-label">{entry.label}</span>
							<span class="font-bold" data-testid="checkout-history-count">count = {entry.count}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<aside class="text-xs opacity-50 leading-relaxed">
		Server: <code>placeOrder = live.idempotent(&#123; ttl: 60 &#125;, ...)</code>.
		Client: <code>placeOrder.with(&#123; idempotencyKey &#125;)()</code>.
		The wire envelope carries the key; identical keys within ttl return
		the cached result. See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/checkout.js">checkout.js</a>.
	</aside>
</div>
