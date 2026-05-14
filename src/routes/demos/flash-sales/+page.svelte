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
		stressResult = null
		const target = stressTarget
		const n = Math.max(1, Math.min(200, Math.floor(stressCount)))
		// `.fresh` bypasses the client SDK's microtask dedup so each call
		// in this batch actually fires its own RPC. Single-buy uses the
		// default coalescing path so an accidental double-click doesn't
		// double-spend stock; the stress button explicitly opts out.
		const results = await Promise.allSettled(Array.from({ length: n }, () => buyProduct.fresh(target)))
		const tally = { ok: 0, soldOut: 0, lockTimeout: 0, other: 0 }
		for (const r of results) {
			if (r.status === 'fulfilled') {
				tally.ok++
			} else {
				const code = r.reason?.code ?? ''
				if (code === 'SOLD_OUT') tally.soldOut++
				else if (code === 'LOCK_TIMEOUT') tally.lockTimeout++
				else tally.other++
			}
		}
		stressResult = tally
		stressBusy = false
	}

	// --- Coupon ---
	let couponBusy = $state(false)
	let couponResult = $state(/** @type {{ kind: 'ok' | 'duplicate' | 'sold-out' | 'error', code?: string, poolRemaining?: number, detail?: string } | null} */ (null))

	async function handleClaimCoupon() {
		if (couponBusy) return
		couponBusy = true
		try {
			const before = state.alreadyClaimed
			const result = await claimCoupon()
			// `live.idempotent` returns the cached first response for the
			// same userId; the second call resolves with the same shape.
			// The page disambiguates "fresh ok" from "duplicate" via the
			// page-state flag flipped on first success.
			couponResult = before
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
	<section class="grid sm:grid-cols-3 gap-3" data-testid="products-section">
		{#each productsList as p (p.id)}
			<div class="card bg-base-100 border border-base-300" data-testid={'product-card-' + p.id}>
				<div class="card-body py-3 space-y-2">
					<div class="flex items-center gap-2">
						<strong class="text-sm" data-testid="product-name">{p.name}</strong>
						{#if p.soldOut}
							<span class="ml-auto badge badge-error badge-sm" data-testid={'product-soldout-' + p.id}>SOLD OUT</span>
						{:else}
							<span class="ml-auto badge {stockClass(p)} badge-sm" data-testid={'product-stock-' + p.id}>{p.stock} / {p.stockInitial} left</span>
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
					<button
						class="btn btn-sm btn-primary w-full"
						onclick={() => handleBuy(p.id)}
						disabled={p.soldOut || busyBuy.has(p.id)}
						data-testid={'product-buy-' + p.id}
					>
						{busyBuy.has(p.id) ? 'Buying...' : (p.soldOut ? 'Sold out' : `Buy $${p.salePrice}`)}
					</button>
				</div>
			</div>
		{:else}
			<p class="opacity-40 text-sm sm:col-span-3">loading...</p>
		{/each}
	</section>

	{#if lastOutcome}
		<div class="alert {outcomeAlert(lastOutcome.kind)} py-2" data-testid="buy-outcome">
			<span class="text-sm">
				<strong data-testid="buy-outcome-kind">{outcomeLabel(lastOutcome.kind)}</strong>
				{#if lastOutcome.detail} - {lastOutcome.detail}{/if}
			</span>
		</div>
	{/if}

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
				<label class="form-control flex-1 min-w-[10rem]">
					<span class="label-text text-xs">Target product</span>
					<select class="select select-bordered select-sm" bind:value={stressTarget} disabled={stressBusy} data-testid="stress-target">
						{#each productsList as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
				<label class="form-control flex-1 min-w-[8rem]">
					<span class="label-text text-xs">Count ({stressCount})</span>
					<input type="range" class="range range-sm" min="1" max="50" step="1" bind:value={stressCount} disabled={stressBusy} data-testid="stress-count" />
				</label>
				<button class="btn btn-sm btn-warning" onclick={handleStress} disabled={stressBusy} data-testid="stress-go">
					{stressBusy ? 'Running...' : `Spam ${stressCount} buys`}
				</button>
				<button class="btn btn-sm btn-ghost" onclick={handleReset} disabled={resetting} data-testid="reset">
					Reset sale
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
