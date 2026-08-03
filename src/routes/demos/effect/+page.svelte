<!--
	/demos/effect: server-side reactive side effects via live.effect.

	Click "Place order". The RPC publishes 'created' on the orders
	topic and returns. A separately-registered
	`live.effect([orders], handler)` fires, fans out to an audit
	feed and a notifications feed. Three streams light up from one
	user action.
-->
<script>
	import { onMount } from 'svelte'
	import { confirmDestructive } from '$lib/confirm-destructive'
	import {
		myEffectState,
		placeOrder,
		clearFeeds,
		ordersStream,
		auditStream,
		notificationsStream
	} from '$live/demos/effect'

	let { data } = $props()
	const me = $derived(data.identity)

	let state = $state({ products: [{ name: 'bagel', price: 4 }], feedCap: 30 })

	onMount(async () => {
		try { state = await myEffectState() } catch {}
	})

	let ordersList = $state([])
	let auditList = $state([])
	let notifsList = $state([])

	$effect(() => {
		const off = ordersStream.subscribe((v) => {
			ordersList = (v ?? []).slice().sort((a, b) => b.ts - a.ts)
		})
		return () => off()
	})

	$effect(() => {
		const off = auditStream.subscribe((v) => {
			auditList = (v ?? []).slice().sort((a, b) => b.ts - a.ts)
		})
		return () => off()
	})

	$effect(() => {
		const off = notificationsStream.subscribe((v) => {
			notifsList = (v ?? []).slice().sort((a, b) => b.ts - a.ts)
		})
		return () => off()
	})

	let selectedProduct = $state('bagel')
	let qty = $state(1)
	let busy = $state(false)
	let lastError = $state('')

	$effect(() => {
		if (state.products.length > 0 && !state.products.find((p) => p.name === selectedProduct)) {
			selectedProduct = state.products[0].name
		}
	})

	async function handlePlace() {
		if (busy) return
		busy = true
		lastError = ''
		try {
			receipt = await placeOrder({ productName: selectedProduct, qty: Math.floor(qty) })
		} catch (err) {
			receipt = null
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busy = false
		}
	}

	let burstBusy = $state(false)
	async function handleBurst() {
		if (burstBusy) return
		burstBusy = true
		lastError = ''
		try {
			const orders = await Promise.all(Array.from({ length: 5 }, (_, i) => placeOrder.fresh({
				productName: state.products[i % state.products.length]?.name ?? selectedProduct,
				qty: 1 + (i % 3)
			})))
			receipt = { burst: orders.length }
		} catch (err) {
			receipt = null
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			burstBusy = false
		}
	}

	let clearing = $state(false)
	async function handleClear() {
		if (clearing) return
		if (!confirmDestructive('Clear all three shared effect feeds?')) return
		clearing = true
		try {
			await clearFeeds()
			receipt = null
		} finally {
			clearing = false
		}
	}

	// On short viewports the three feed cards sit below the fold, so a
	// successful publish looked like nothing happening. The receipt names
	// what was just placed and offers the jump, instead of hoping the
	// visitor scrolls.
	let receipt = $state(null)
	let columnsEl = $state(null)

	function jumpToFeeds() {
		columnsEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
	}

	function timeOf(ts) {
		const d = new Date(ts)
		return d.toLocaleTimeString()
	}

	// Audit and notification rows arrive with the orderId they were
	// caused by; the source order carries the buyer identity. Joining
	// them here is what lets every downstream row wear its cause.
	const orderById = $derived(new Map(ordersList.map((o) => [o.id, o])))
	const refOf = (id) => `#${String(id ?? '').replace(/^ord-/, '')}`
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">live.effect: one publish, three streams</h1>
		<p class="text-sm opacity-70 mt-1">
			Place an order. The RPC publishes <code>'created'</code> on the
			orders topic and returns. A separately-registered
			<code>live.effect([orders], handler)</code> fires, fans out to
			an audit feed and a notifications feed. Three streams light up
			from one user action; the effect handler is fire-and-forget,
			runs on the server, and the original publisher (the
			<code>placeOrder</code> RPC) doesn't wait for it.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Acting as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Place order -->
	<section class="card bg-base-200" data-testid="place-section">
		<div class="card-body py-3 space-y-2">
			<form onsubmit={(e) => { e.preventDefault(); handlePlace() }} class="flex flex-wrap gap-2 items-end">
				<label class="flex flex-col gap-1 flex-1 min-w-[10rem]">
					<span class="opacity-70 text-xs">Product</span>
					<!-- Compact on fine pointers, 44px floor where taps land. -->
					<select class="select select-bordered select-sm pointer-coarse:min-h-11" bind:value={selectedProduct} disabled={busy} data-testid="place-product">
						{#each state.products as p (p.name)}
							<option value={p.name}>{p.name} (${p.price})</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 flex-1 min-w-[6rem]">
					<span class="opacity-70 text-xs">Qty</span>
					<input type="number" class="input input-bordered input-sm pointer-coarse:min-h-11" min="1" max="20" step="1" required bind:value={qty} disabled={busy} data-testid="place-qty" />
				</label>
				<!-- One wrapping unit for the actions: on a phone the inputs may
				     reflow, but the two publish buttons never separate and Clear
				     keeps its distance on the right. -->
				<div class="flex flex-wrap gap-2 items-end grow">
					<button type="submit" class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" disabled={busy} data-testid="place-submit">
						{busy ? 'Placing...' : 'Place order'}
					</button>
					<button type="button" class="btn btn-sm btn-warning pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleBurst} disabled={burstBusy} data-testid="burst">
						{burstBusy ? 'Bursting...' : 'Burst (5)'}
					</button>
					<button type="button" class="btn btn-sm btn-outline btn-error ml-auto pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleClear} disabled={clearing} data-testid="clear">
						Clear feeds
					</button>
				</div>
			</form>
			{#if lastError}
				<p class="text-xs text-error" data-testid="error">{lastError}</p>
			{:else if receipt}
				<p class="text-xs opacity-80" aria-live="polite" data-testid="receipt">
					{#if receipt.burst}
						{receipt.burst} orders placed
					{:else}
						{receipt.qty}x {receipt.productName} placed
						<span class="font-mono">{refOf(receipt.id)}</span>
					{/if}
					- all three feeds picked it up.
					<button type="button" class="link" onclick={jumpToFeeds} data-testid="receipt-jump">Jump to the feeds</button>
				</p>
			{/if}
		</div>
	</section>

	<!-- Three columns -->
	<!-- @2xl, not @3xl: below 1024 there is no sidebar, so the content container
	     is the viewport minus padding. Mapping the old md: (768px viewport)
	     straight to @3xl (768px container) pushed three-up past the 768 rung it
	     is supposed to engage at. The finding this grid answers was about 640,
	     where a 672px container still stacks. -->
	<section class="grid @2xl:grid-cols-3 gap-3" data-testid="columns" bind:this={columnsEl}>
		<div class="card bg-base-100 border border-base-300" data-testid="orders-column">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Orders ({ordersList.length})</h2>
				<p class="text-xs opacity-70">source topic; the RPC publishes here.</p>
				<ul class="space-y-1 text-xs" data-testid="orders-list">
					{#each ordersList as o (o.id)}
						<li class="flex items-center gap-2" data-testid="orders-row">
							<span class="opacity-50 w-16">{timeOf(o.ts)}</span>
							<span class="inline-block w-2 h-2 rounded-full shrink-0" style:background={o.buyerColor} role="img" aria-label="buyer {o.buyerName}" title={o.buyerName}></span>
							<span class="font-mono opacity-60" data-testid="orders-ref">{refOf(o.id)}</span>
							<span class="font-medium" data-testid="orders-product">{o.qty}x {o.productName}</span>
							<span class="ml-auto font-mono">${o.total}</span>
						</li>
					{:else}
						<li class="opacity-70 text-xs" data-testid="orders-empty">no orders yet</li>
					{/each}
				</ul>
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300" data-testid="audit-column">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Audit ({auditList.length})</h2>
				<p class="text-xs opacity-70">populated by the effect handler.</p>
				<ul class="space-y-1 text-xs" data-testid="audit-list">
					{#each auditList as a (a.id)}
						{@const cause = orderById.get(a.orderId)}
						<li class="flex items-center gap-2" data-testid="audit-row">
							<span class="opacity-50 w-16">{timeOf(a.ts)}</span>
							{#if cause}
								<span class="inline-block w-2 h-2 rounded-full shrink-0" style:background={cause.buyerColor} role="img" aria-label="buyer {cause.buyerName}" title={cause.buyerName}></span>
							{/if}
							<span class="font-mono opacity-60" data-testid="audit-ref">{refOf(a.orderId)}</span>
							<span class="badge badge-xs badge-info">{a.level}</span>
							<span class="flex-1 truncate" data-testid="audit-message">{a.message}</span>
						</li>
					{:else}
						<li class="opacity-70 text-xs" data-testid="audit-empty">no audit entries yet</li>
					{/each}
				</ul>
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300" data-testid="notifications-column">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Notifications ({notifsList.length})</h2>
				<p class="text-xs opacity-70">populated by the same effect handler.</p>
				<ul class="space-y-1 text-xs" data-testid="notifications-list">
					{#each notifsList as n (n.id)}
						{@const cause = orderById.get(n.orderId)}
						<li class="flex items-center gap-2" data-testid="notifications-row">
							<span class="opacity-50 w-16">{timeOf(n.ts)}</span>
							{#if cause}
								<span class="inline-block w-2 h-2 rounded-full shrink-0" style:background={cause.buyerColor} role="img" aria-label="buyer {cause.buyerName}" title={cause.buyerName}></span>
							{/if}
							<span class="font-mono opacity-60" data-testid="notifications-ref">{refOf(n.orderId)}</span>
							<span class="flex-1 truncate" data-testid="notifications-message">{n.message}</span>
						</li>
					{:else}
						<li class="opacity-70 text-xs" data-testid="notifications-empty">no notifications yet</li>
					{/each}
				</ul>
			</div>
		</div>
	</section>

	<aside class="text-xs opacity-70 leading-relaxed space-y-2">
		<p>
			Server: <code>live.effect([TOPICS.demoEffectOrders], async (event, data, platform) =&gt; &#123; ... &#125;)</code>.
			The handler runs on every publish to any source topic. It
			receives the event kind, the published data, and a platform
			reference for fan-out via <code>platform.publish(...)</code>.
		</p>
		<p>
			Fire-and-forget: throws inside the handler are swallowed by the
			framework so a downstream service outage doesn't fail the
			original publisher's RPC. Log them via
			<code>live.onError(...)</code> if you want visibility. Compose
			multiple effects on the same source topic for orthogonal
			side-effect chains (notifications, billing, analytics, etc.)
			without coupling them to each other.
		</p>
	</aside>
</div>
