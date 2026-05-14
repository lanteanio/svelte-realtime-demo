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
		await reset()
		history = []
	}
</script>

<div class="max-w-2xl mx-auto p-8 space-y-6">
	<header>

		<h1 class="text-2xl font-bold mt-2">Idempotency under double-click</h1>
		<p class="text-sm opacity-70 mt-1">
			Click "Retry x5 (same key)" to fire five rapid RPCs with the same
			idempotencyKey. Only the first runs the handler; the other four
			return the cached result. One intent, one effect.
		</p>
	</header>

	<div class="card bg-base-200 shadow">
		<div class="card-body items-center text-center py-10">
			<div class="text-sm opacity-60">Total orders placed</div>
			<div class="text-7xl font-bold tabular-nums">{$count ?? 0}</div>
		</div>
	</div>

	<div class="flex flex-wrap gap-3 justify-center">
		<button class="btn btn-primary" onclick={fireOne} disabled={busy}>
			Place Order
		</button>
		<button class="btn btn-warning" onclick={fireFive} disabled={busy}>
			Retry x5 (same key)
		</button>
		<button class="btn btn-ghost" onclick={handleReset}>Reset</button>
	</div>

	{#if history.length > 0}
		<div class="card bg-base-100 border border-base-300">
			<div class="card-body py-4">
				<h2 class="card-title text-sm">RPC history (newest first)</h2>
				<ul class="text-xs space-y-1 font-mono">
					{#each history as entry, i (i + entry.key + entry.label)}
						<li class="flex justify-between gap-3">
							<span class="opacity-60 truncate max-w-[18ch]" title={entry.key}>{entry.key.slice(0, 8)}...</span>
							<span class="opacity-60">{entry.label}</span>
							<span class="font-bold">count = {entry.count}</span>
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
