<!--
	/demos/flash-sales: atomic inventory decrement under contention.

	Three products with limited stock. Click Buy and watch the counter
	tick down in real time across every connected tab. The server runs
	`live.lock({ key, maxWaitMs })` per product so concurrent buys
	serialize FIFO and the count never goes negative. Spam the stress
	button to surface `LOCK_TIMEOUT`: queued waiters past the bound
	get rejected instead of waiting forever.

	The coupon section uses `live.idempotent` keyed on the caller's
	userId for one-per-user enforcement: a flaky reconnect-retry from
	the same user gets the cached first response, never decrements
	the coupon pool a second time.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import { confirmDestructive } from '$lib/confirm-destructive'
	import {
		myFlashState,
		buyProduct,
		claimCoupon,
		resetSale,
		productList,
		recentSales
	} from '$live/demos/flash-sales'

	let { data } = $props()
	const me = $derived(data.identity)

	let state = $state({
		productLockMaxWaitMs: 1500,
		perBuyDelayMs: 80,
		salesCap: 30,
		couponCode: 'SAVE20',
		couponPoolInitial: 50,
		couponPoolRemaining: 50,
		alreadyClaimed: false
	})

	onMount(async () => {
		try { state = await myFlashState() } catch {}
	})

	// --- Live streams ---
	let productsList = $state([])
	let salesList = $state([])

	$effect(() => {
		const off = productList.subscribe((v) => {
			productsList = (v ?? []).slice()
		})
		return () => off()
	})

	$effect(() => {
		const off = recentSales.subscribe((v) => {
			salesList = (v ?? []).slice().sort((a, b) => b.ts - a.ts)
		})
		return () => off()
	})

	// --- Wall clock for time-ago labels ---
	let nowMs = $state(Date.now())
	let clockTimer = null
	onMount(() => {
		clockTimer = setInterval(() => { nowMs = Date.now() }, 250)
	})
	onDestroy(() => {
		if (clockTimer) clearInterval(clockTimer)
	})

	function timeAgo(ts) {
		const s = Math.max(0, Math.round((nowMs - ts) / 1000))
		if (s < 5) return 'just now'
		if (s < 60) return `${s}s ago`
		const m = Math.floor(s / 60)
		return `${m}m ago`
	}

	// --- Buy single ---
	let busyBuy = $state(/** @type {Set<string>} */ (new Set()))
	let lastOutcome = $state(/** @type {{ kind: string, detail: string } | null} */ (null))

	function setBusy(id, on) {
		const next = new Set(busyBuy)
		if (on) next.add(id)
		else next.delete(id)
		busyBuy = next
	}

	async function handleBuy(productId) {
		if (busyBuy.has(productId)) return
		setBusy(productId, true)
		lastOutcome = null
		try {
			const result = await buyProduct(productId)
			lastOutcome = { kind: 'sold', detail: `${result.sale.productName} for $${result.sale.salePrice}` }
		} catch (err) {
			const code = err?.code ?? 'ERROR'
			lastOutcome = { kind: code.toLowerCase(), detail: err?.message ?? String(err) }
		} finally {
			setBusy(productId, false)
		}
	}

	// --- Stress: spam N buys at one product, count outcomes ---
	let stressTarget = $state('phone')
	let stressCount = $state(20)
	let stressBusy = $state(false)
	let stressResult = $state(/** @type {{ ok: number, soldOut: number, lockTimeout: number, other: number } | null} */ (null))

	async function handleStress() {
		if (stressBusy) return
		stressBusy = true
		const target = stressTarget
		const n = Math.max(1, Math.min(200, Math.floor(stressCount)))
		// Live tally: each settlement bumps its counter immediately, so the
		// FIFO drain is visible WHILE the burst runs instead of only after
		// every promise settles.
		stressResult = { ok: 0, soldOut: 0, lockTimeout: 0, other: 0 }
		// `.fresh` bypasses the client SDK's microtask dedup so each call
		// in this batch actually fires its own RPC. Single-buy uses the
		// default coalescing path so an accidental double-click doesn't
		// double-spend stock; the stress button explicitly opts out.
		await Promise.allSettled(Array.from({ length: n }, () =>
			buyProduct.fresh(target).then(
				() => { stressResult = { ...stressResult, ok: stressResult.ok + 1 } },
				(err) => {
					const code = err?.code ?? ''
					if (code === 'SOLD_OUT') stressResult = { ...stressResult, soldOut: stressResult.soldOut + 1 }
					else if (code === 'LOCK_TIMEOUT') stressResult = { ...stressResult, lockTimeout: stressResult.lockTimeout + 1 }
					else stressResult = { ...stressResult, other: stressResult.other + 1 }
				}
			)
		))
		stressBusy = false
	}

	// --- Coupon ---
	let couponBusy = $state(false)
	let couponResult = $state(/** @type {{ kind: 'ok' | 'duplicate' | 'sold-out' | 'error', code?: string, poolRemaining?: number, detail?: string } | null} */ (null))

	async function handleClaimCoupon() {
		if (couponBusy) return
		couponBusy = true
		try {
			// Ask the server whether this identity already holds the coupon,
			// immediately before claiming. Neither of the two locally available
			// signals can answer it: this tab's snapshot goes stale the moment
			// another tab on the same identity claims, and `live.idempotent`
			// replays the FIRST call's body, so the response a duplicate
			// receives is byte-identical to the one the fresh claim got - pool
			// number included. Only a read taken now distinguishes them.
			let heldBefore = state.alreadyClaimed
			try {
				const authoritative = await myFlashState()
				heldBefore = authoritative.alreadyClaimed
				state = { ...state, ...authoritative }
			} catch {
				// Probe failed: fall back to this tab's own belief, which is
				// right for the single-tab case.
			}
			const result = await claimCoupon()
			couponResult = heldBefore
				? { kind: 'duplicate', code: result.code, poolRemaining: result.poolRemaining }
				: { kind: 'ok', code: result.code, poolRemaining: result.poolRemaining }
			state = { ...state, alreadyClaimed: true, couponPoolRemaining: result.poolRemaining }
		} catch (err) {
			const code = err?.code ?? 'ERROR'
			couponResult = { kind: code === 'SOLD_OUT' ? 'sold-out' : 'error', detail: err?.message ?? String(err) }
		} finally {
			couponBusy = false
		}
	}

	// --- Reset ---
	let resetting = $state(false)
	async function handleReset() {
		if (resetting) return
		if (!confirmDestructive('Reset the shared sale, stock, and coupon pool?')) return
		resetting = true
		try {
			await resetSale()
			lastOutcome = null
			stressResult = null
			couponResult = null
			state = { ...state, alreadyClaimed: false, couponPoolRemaining: state.couponPoolInitial }
		} finally {
			resetting = false
		}
	}

	function outcomeAlert(kind) {
		switch (kind) {
			case 'sold': return 'alert-success'
			case 'sold_out': return 'alert-warning'
			case 'lock_timeout': return 'alert-warning'
			default: return 'alert-error'
		}
	}

	function outcomeLabel(kind) {
		switch (kind) {
			case 'sold': return 'sold'
			case 'sold_out': return 'sold out'
			case 'lock_timeout': return 'lock timeout'
			case 'validation': return 'validation'
			default: return kind
		}
	}

	function stockClass(p) {
		if (p.soldOut) return 'badge-error'
		if (p.stock <= Math.ceil(p.stockInitial / 3)) return 'badge-warning'
		return 'badge-success'
	}

	function stockProgress(p) {
		if (p.stockInitial <= 0) return 0
		return Math.max(0, Math.min(1, p.stock / p.stockInitial))
	}
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Flash sales: atomic inventory under contention</h1>
		<p class="text-sm opacity-70 mt-1">
			Three products with limited stock. Click Buy and watch the count
			tick down in real time. Server runs
			<code>live.lock(&#123; key: (ctx, id) =&gt; 'flash:product:' + id, maxWaitMs: {state.productLockMaxWaitMs} &#125;, ...)</code>
			so concurrent buys on one product serialize FIFO and stock never
			goes negative. Spam the stress button to surface
			<code>LOCK_TIMEOUT</code>: queued waiters past the bound get
			rejected instead of holding the request indefinitely.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Shopping as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Coupon -->
	<section class="card bg-base-200" data-testid="coupon-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Coupon: {state.couponCode} (one per user)</h2>
			<div class="flex items-center gap-2 flex-wrap">
				<button
					class="btn btn-sm btn-secondary"
					onclick={handleClaimCoupon}
					disabled={couponBusy}
					data-testid="coupon-claim"
				>
					{couponBusy ? 'Claiming...' : (state.alreadyClaimed ? 'Re-check coupon' : 'Claim coupon')}
				</button>
				<span class="text-xs opacity-60">
					Pool remaining: <strong data-testid="coupon-pool">{state.couponPoolRemaining}</strong> / {state.couponPoolInitial}
				</span>
				{#if couponResult}
					{#if couponResult.kind === 'ok'}
						<span class="badge badge-success badge-sm" data-testid="coupon-result">Claimed: <code>{couponResult.code}</code></span>
					{:else if couponResult.kind === 'duplicate'}
						<span class="badge badge-warning badge-sm" data-testid="coupon-result">Already claimed: <code>{couponResult.code}</code></span>
					{:else if couponResult.kind === 'sold-out'}
						<span class="badge badge-error badge-sm" data-testid="coupon-result">Pool exhausted</span>
					{:else}
						<span class="badge badge-error badge-sm" data-testid="coupon-result">{couponResult.detail}</span>
					{/if}
				{/if}
			</div>
		</div>
	</section>

	<!-- Product cards -->
	<section class="grid @3xl:grid-cols-3 gap-3" data-testid="products-section">
		{#each productsList as p (p.id)}
			<div class="card bg-base-100 border border-base-300" data-testid={'product-card-' + p.id}>
				<div class="card-body py-3 space-y-2">
					<div class="flex items-center gap-2">
						<strong class="text-sm min-w-0 truncate" title={p.name} data-testid="product-name">{p.name}</strong>
						{#if p.soldOut}
							<span class="ml-auto shrink-0 whitespace-nowrap badge badge-error badge-sm" data-testid={'product-soldout-' + p.id}>SOLD OUT</span>
						{:else}
							<span class="ml-auto shrink-0 whitespace-nowrap badge {stockClass(p)} badge-sm" data-testid={'product-stock-' + p.id}>{p.stock} / {p.stockInitial} left</span>
						{/if}
					</div>
					<div class="flex items-baseline gap-2">
						<span class="text-lg font-bold" data-testid="product-saleprice">${p.salePrice}</span>
						<span class="text-sm opacity-50 line-through">${p.originalPrice}</span>
					</div>
					<progress class="progress progress-primary w-full" value={stockProgress(p)} max="1"></progress>
					<div class="flex items-center gap-2 text-xs opacity-60">
						<span data-testid={'product-sold-' + p.id}>sold: {p.sold}</span>
					</div>
					<!-- The racing CTA: compact on fine pointers, 44px where taps land. -->
					<button
						class="btn btn-sm btn-primary w-full pointer-coarse:min-h-11"
						onclick={() => handleBuy(p.id)}
						disabled={p.soldOut || busyBuy.has(p.id)}
						data-testid={'product-buy-' + p.id}
					>
						{busyBuy.has(p.id) ? 'Buying...' : (p.soldOut ? 'Sold out' : `Buy $${p.salePrice}`)}
					</button>
				</div>
			</div>
		{:else}
			<!-- Skeletons hold the grid's shape until the product stream lands. -->
			{#each Array(3) as _, i (i)}
				<div class="card bg-base-100 border border-base-300" data-testid="product-skeleton">
					<div class="card-body py-3 space-y-2">
						<div class="skeleton h-4 w-2/3"></div>
						<div class="skeleton h-6 w-1/3"></div>
						<div class="skeleton h-2 w-full"></div>
						<div class="skeleton h-8 w-full"></div>
					</div>
				</div>
			{/each}
		{/each}
	</section>

	<!-- A FIXED slot, not a minimum. min-h-10 reserved one line, so a longer
	     outcome that wrapped at narrow rungs still grew the box and shoved the
	     stress panel down. The box is now a constant height at every rung and a
	     long message scrolls inside it. -->
	<div class="h-16" data-testid="buy-outcome-slot">
		{#if lastOutcome}
			<div class="alert {outcomeAlert(lastOutcome.kind)} py-2 h-full items-start overflow-y-auto" data-testid="buy-outcome">
				<span class="text-sm">
					<strong data-testid="buy-outcome-kind">{outcomeLabel(lastOutcome.kind)}</strong>
					{#if lastOutcome.detail} - {lastOutcome.detail}{/if}
				</span>
			</div>
		{/if}
	</div>

	<!-- Stress test -->
	<section class="card bg-base-200" data-testid="stress-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Stress: spam buys at one product</h2>
			<p class="text-xs opacity-60">
				Drives concurrent buys at the chosen product. Lock serializes
				them; bursts past <code>maxWaitMs</code> ({state.productLockMaxWaitMs}ms)
				surface as <code>LOCK_TIMEOUT</code>. Per-buy artificial delay
				is {state.perBuyDelayMs}ms.
			</p>
			<div class="flex flex-wrap gap-2 items-end">
				<label class="flex flex-col gap-1 flex-1 min-w-[10rem]">
					<span class="opacity-70 text-xs">Target product</span>
					<select class="select select-bordered select-sm" bind:value={stressTarget} disabled={stressBusy || productsList.length === 0} data-testid="stress-target">
						{#each productsList as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 flex-1 min-w-[8rem]">
					<span class="opacity-70 text-xs">Count ({stressCount})</span>
					<input type="range" class="range range-sm" min="1" max="50" step="1" bind:value={stressCount} disabled={stressBusy} data-testid="stress-count" />
				</label>
				<button class="btn btn-sm btn-warning" onclick={handleStress} disabled={stressBusy || productsList.length === 0} data-testid="stress-go">
					{stressBusy ? 'Running...' : `Spam ${stressCount} buys`}
				</button>
				<!-- Page-scoped reset, so its label owns its real blast radius. -->
				<button class="btn btn-sm btn-outline btn-error ml-auto" onclick={handleReset} disabled={resetting} data-testid="reset">
					Reset demo (stock + coupons)
				</button>
			</div>
			{#if stressResult}
				<div class="flex flex-wrap gap-2 text-xs" data-testid="stress-result">
					<span class="badge badge-success" data-testid="stress-ok">{stressResult.ok} ok</span>
					<span class="badge badge-error" data-testid="stress-soldout">{stressResult.soldOut} sold-out</span>
					<span class="badge badge-warning" data-testid="stress-locktimeout">{stressResult.lockTimeout} lock-timeout</span>
					{#if stressResult.other > 0}
						<span class="badge badge-ghost" data-testid="stress-other">{stressResult.other} other</span>
					{/if}
				</div>
			{/if}
		</div>
	</section>

	<!-- Sales feed -->
	<section class="card bg-base-100 border border-base-300" data-testid="sales-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Recent sales ({salesList.length})</h2>
			{#if salesList.length === 0}
				<p class="opacity-40 text-sm" data-testid="sales-empty">Nothing yet.</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono" data-testid="sales-list">
					{#each salesList as s (s.id)}
						<li class="flex items-center gap-2" data-testid="sales-row">
							<span class="opacity-50 w-14">{timeAgo(s.ts)}</span>
							<span class="inline-block w-2 h-2 rounded-full" style:background={s.buyerColor}></span>
							<span class="opacity-70 flex-1 truncate">{s.buyerName} bought {s.productName}</span>
							<span class="font-medium">${s.salePrice}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>buyProduct = live.lock(&#123; key: (ctx, id) =&gt; 'flash:product:' + id, maxWaitMs: {state.productLockMaxWaitMs} &#125;, fn)</code>.
			Default in-process lock; for multi-instance deployments swap in
			<code>createDistributedLock(redis)</code> from
			<code>svelte-adapter-uws-extensions/redis/lock</code> without
			changing the caller-facing API.
		</p>
		<p>
			Coupon: <code>claimCoupon = live.idempotent(&#123; keyFrom: (ctx) =&gt; 'flash:coupon:' + ctx.user.id, ttl: 3600 &#125;, fn)</code>.
			A second claim from the same user returns the cached first
			response; the coupon pool decrements at most once per user
			regardless of retry pressure.
		</p>
	</aside>
</div>
