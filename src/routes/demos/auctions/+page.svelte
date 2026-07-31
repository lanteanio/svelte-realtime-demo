<!--
	/demos/auctions: deadline-bounded parallel `live.push` collection.

	Open this page in two or three browsers (separate identities). One
	tab lists a lot (item, starting price, reserve, duration). The
	server fans out a `live.push` to every other tab with a deadline
	equal to the lot's duration. Each recipient's tab pops a bid card
	with a live "current top" readout (driven by the active-lots
	stream) and Bid / Pass buttons. The seller and every spectator
	watch the bid waterfall fill in real time. After the deadline the
	highest bid above the reserve wins; otherwise no-sale.

	Three primitives in one page: live.push x N parallel +
	Promise.allSettled (the headline), per-bid ctx.publish on the
	active stream (the live race), and live.stream x 2 for active and
	recent feeds.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import { presence } from 'svelte-adapter-uws/plugins/presence/client'
	import { status as wsStatus } from 'svelte-adapter-uws/client'
	import { onPush } from 'svelte-realtime/client'
	import {
		myAuctionsState,
		createAuction,
		activeAuctions,
		recentResults
	} from '$live/demos/auctions'

	let { data } = $props()
	const me = $derived(data.identity)

	const globalPresence = presence('global', { maxAge: 90000 })
	const otherUsers = $derived(($globalPresence ?? []).filter((u) => u.id !== me?.id))

	let caps = $state({
		maxItemLen: 60,
		maxPrice: 1_000_000,
		minDurationSec: 3,
		maxDurationSec: 30,
		maxRecipients: 50,
		maxActivePerSeller: 3,
		pushEvent: 'demos:auction:bid-request'
	})

	onMount(async () => {
		try {
			caps = await myAuctionsState()
		} catch {}
	})

	// --- Live streams ---
	let activeList = $state([])
	let recentList = $state([])

	$effect(() => {
		const off = activeAuctions.subscribe((v) => {
			activeList = (v ?? []).slice().sort((a, b) => a.deadlineAt - b.deadlineAt)
		})
		return () => off()
	})

	$effect(() => {
		const off = recentResults.subscribe((v) => {
			recentList = (v ?? []).slice().sort((a, b) => b.closedAt - a.closedAt)
		})
		return () => off()
	})

	// --- Wall clock for countdowns ---
	let nowMs = $state(Date.now())
	let clockTimer = null
	onMount(() => {
		clockTimer = setInterval(() => { nowMs = Date.now() }, 100)
	})
	onDestroy(() => {
		if (clockTimer) clearInterval(clockTimer)
	})

	function secondsLeft(deadlineAt) {
		return Math.max(0, Math.ceil((deadlineAt - nowMs) / 1000))
	}

	function timeAgo(ts) {
		const s = Math.max(0, Math.round((nowMs - ts) / 1000))
		if (s < 5) return 'just now'
		if (s < 60) return `${s}s ago`
		const m = Math.floor(s / 60)
		return `${m}m ago`
	}

	function topBid(lot) {
		if (!lot?.bids || lot.bids.length === 0) return null
		const sorted = lot.bids.slice().sort((a, b) => b.amount - a.amount || a.ts - b.ts)
		return sorted[0]
	}

	// --- Inbox: incoming bid-request cards ---
	/**
	 * @typedef {object} BidCard
	 * @property {string} lotId
	 * @property {string} item
	 * @property {string} sellerName
	 * @property {string} sellerColor
	 * @property {number} startingPrice
	 * @property {number} reservePrice
	 * @property {number} deadlineAt
	 * @property {(reply: any) => void} resolve
	 * @property {'pending' | 'submitted' | 'passed' | 'won' | 'outbid' | 'no-sale' | 'no-bidders'} state
	 * @property {number | null} myAmount
	 * @property {number} draftAmount
	 * @property {object | null} outcome
	 */
	/** @type {BidCard[]} */
	let inbox = $state([])

	let unregisterPush = null
	let pushHandlerInstalled = $state(false)
	let pushReady = $state(false)

	// pushReady gates the cross-tab push tests: it must mean both
	// "handler installed on this tab" AND "WS open so the server-side
	// push registry holds this tab's ws". An always-true gate signalled
	// visibility before the WS connected, so a fast `live.push` from
	// the seller could race the bidder's open hook and be dropped.
	$effect(() => {
		if ($wsStatus === 'open' && pushHandlerInstalled) pushReady = true
	})

	onMount(() => {
		unregisterPush = onPush(caps.pushEvent ?? 'demos:auction:bid-request', (data) => {
			return new Promise((resolve) => {
				/** @type {BidCard} */
				const card = {
					lotId: data.id,
					item: data.item,
					sellerName: data.sellerName,
					sellerColor: data.sellerColor,
					startingPrice: data.startingPrice,
					reservePrice: data.reservePrice,
					deadlineAt: data.deadlineAt,
					resolve,
					state: 'pending',
					myAmount: null,
					draftAmount: data.startingPrice + 1,
					outcome: null
				}
				inbox = [...inbox, card]
			})
		})
		pushHandlerInstalled = true
	})
	onDestroy(() => {
		unregisterPush?.()
	})

	// Reactively settle inbox cards once the lot lands in recent results.
	$effect(() => {
		const recentById = new Map(recentList.map((r) => [r.id, r]))
		let changed = false
		const next = inbox.map((card) => {
			if (card.state === 'won' || card.state === 'outbid' || card.state === 'no-sale' || card.state === 'no-bidders') return card
			const final = recentById.get(card.lotId)
			if (!final) return card
			changed = true
			let nextState = card.state
			if (final.status === 'sold') {
				if (final.winnerId === me?.id) nextState = 'won'
				else nextState = 'outbid'
			} else if (final.status === 'no-sale') {
				nextState = 'no-sale'
			} else {
				nextState = 'no-bidders'
			}
			return { ...card, state: nextState, outcome: final }
		})
		if (changed) inbox = next
	})

	function activeLotForCard(card) {
		return activeList.find((l) => l.id === card.lotId) ?? null
	}

	function liveTopForCard(card) {
		const lot = activeLotForCard(card)
		const t = lot ? topBid(lot) : null
		if (t) return t.amount
		return card.startingPrice
	}

	function submitBid(card, amount) {
		if (card.state !== 'pending') return
		const lot = activeLotForCard(card)
		const top = lot ? topBid(lot) : null
		const floor = top ? top.amount + 1 : card.startingPrice
		if (!Number.isFinite(amount) || amount < floor) {
			// A rival bid can raise the floor between reading and pressing
			// Enter; a silent no-op strands the user. Say so and re-arm the
			// draft at the new floor.
			card.draftAmount = floor
			card.floorNotice = top
				? `outbid - top is now $${top.amount}, bid at least $${floor}`
				: `bid at least $${floor}`
			return
		}
		card.floorNotice = ''
		card.resolve({
			amount,
			bidderName: me?.name ?? '(unknown)',
			bidderColor: me?.color ?? '#888888'
		})
		inbox = inbox.map((c) => c.lotId === card.lotId ? { ...c, state: 'submitted', myAmount: amount } : c)
	}

	function passCard(card) {
		if (card.state !== 'pending') return
		card.resolve({ pass: true })
		inbox = inbox.map((c) => c.lotId === card.lotId ? { ...c, state: 'passed' } : c)
	}

	function dismissCard(card) {
		if (card.state === 'pending') {
			card.resolve({ pass: true })
		}
		inbox = inbox.filter((c) => c.lotId !== card.lotId)
	}

	// --- List a Lot form ---
	let item = $state('')
	let startingPrice = $state(10)
	let reservePrice = $state(20)
	let durationSec = $state(8)
	let listing = $state(false)
	let lastResult = $state(null)
	let formError = $state('')

	const myActiveCount = $derived(activeList.filter((l) => l.sellerId === me?.id).length)
	// The first unmet listing rule, said out loud instead of a mute disable.
	const listHint = $derived.by(() => {
		if (listing) return ''
		if (item.trim().length === 0) return 'Name the item to list it.'
		if (!Number.isFinite(startingPrice)) return 'Set a starting price.'
		if (!Number.isFinite(reservePrice) || reservePrice < startingPrice) return 'Reserve must be at least the starting price.'
		if (myActiveCount >= (caps.maxActivePerSeller ?? 3)) return `You are at the ${caps.maxActivePerSeller ?? 3}-lot limit; wait for one to close.`
		return ''
	})
	// With nothing live, the creation affordance leads on small rungs so the
	// first viewport is not two empty cards.
	const nothingLive = $derived(inbox.length === 0 && activeList.length === 0)
	const canList = $derived(
		!listing
			&& item.trim().length > 0
			&& Number.isFinite(startingPrice)
			&& Number.isFinite(reservePrice)
			&& reservePrice >= startingPrice
			&& myActiveCount < (caps.maxActivePerSeller ?? 3)
	)

	async function handleList() {
		if (!canList) return
		listing = true
		formError = ''
		lastResult = null
		try {
			const recipientIds = otherUsers.map((u) => u.id)
			const result = await createAuction({
				item: item.trim(),
				startingPrice: Math.floor(startingPrice),
				reservePrice: Math.floor(reservePrice),
				durationSec: Math.floor(durationSec),
				recipientIds
			})
			lastResult = result
			item = ''
		} catch (err) {
			formError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			listing = false
		}
	}

	function statusLabel(status) {
		switch (status) {
			case 'sold': return 'sold'
			case 'no-sale': return 'no-sale'
			case 'no-bidders': return 'no-bidders'
			default: return status
		}
	}

	function statusBadgeClass(status) {
		switch (status) {
			case 'sold': return 'badge-success'
			case 'no-sale': return 'badge-warning'
			case 'no-bidders': return 'badge-ghost'
			default: return 'badge-ghost'
		}
	}

	function inboxStateLabel(s) {
		switch (s) {
			case 'pending':     return 'place your bid'
			case 'submitted':   return 'bid placed, waiting'
			case 'passed':      return 'passed, waiting'
			case 'won':         return 'you won'
			case 'outbid':      return 'outbid'
			case 'no-sale':     return 'no-sale'
			case 'no-bidders':  return 'no-bidders'
			default:            return s
		}
	}

	function inboxStateClass(s) {
		switch (s) {
			case 'won':         return 'alert-success'
			case 'outbid':      return 'alert-warning'
			case 'no-sale':     return 'alert-warning'
			case 'no-bidders':  return 'alert-info'
			case 'submitted':   return 'alert-info'
			case 'passed':      return 'alert-info'
			default:            return 'alert-info'
		}
	}

	function lastResultLabel(r) {
		if (!r) return ''
		if (r.status === 'sold') return `sold to ${r.winnerName} for $${r.soldPrice}`
		if (r.status === 'no-sale') return 'no-sale (reserve not met)'
		if (r.status === 'no-bidders') return 'no-bidders (nobody else online)'
		return r.status
	}
</script>

<div class="max-w-4xl mx-auto p-8 flex flex-col gap-4">
	<header class="order-first">

		<h1 class="text-2xl font-bold mt-2">Auctions: deadline-bounded bid race</h1>
		<p class="text-sm opacity-70 mt-1">
			List a lot. The server fans out a <code>live.push</code> to every other
			tab with the lot's duration as the deadline.
			<code>Promise.allSettled</code> collects every reply by then; the
			highest bid above the reserve wins. Bids stream into the active panel
			in real time as each <code>live.push</code> resolves.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Listing as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono" data-testid="my-id" data-user-id={me.id}>({me.id.slice(0, 8)})</span>
				{#if otherUsers.length === 0}
					<span class="ml-2 badge badge-warning badge-sm" data-testid="alone-badge">alone here</span>
				{:else}
					<span class="ml-2 badge badge-success badge-outline badge-sm">{otherUsers.length} potential bidder{otherUsers.length === 1 ? '' : 's'}</span>
				{/if}
				{#if pushReady}
					<span data-testid="push-ready" hidden></span>
				{/if}
			</p>
		{/if}
	</header>

	<!-- Inbox: incoming bid-request cards -->
	<section class="card bg-base-100 border border-base-300" data-testid="inbox-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Inbox ({inbox.length})</h2>
			{#if inbox.length === 0}
				<p class="opacity-40 text-sm" data-testid="inbox-empty">
					No bid requests right now. When a seller lists a lot, this is where
					their <code>live.push</code> lands.
				</p>
			{:else}
				<ul class="space-y-2" data-testid="inbox-list">
					{#each inbox as card (card.lotId)}
						{@const lot = activeLotForCard(card)}
						{@const top = lot ? topBid(lot) : null}
						{@const liveTop = liveTopForCard(card)}
						{@const left = secondsLeft(card.deadlineAt)}
						{@const isOver = left === 0}
						<li class="alert {inboxStateClass(card.state)} flex-col items-stretch gap-2" data-testid="inbox-card">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="inline-block w-2 h-2 rounded-full" style:background={card.sellerColor}></span>
								<strong class="text-sm" data-testid="inbox-card-seller">{card.sellerName}</strong>
								<span class="opacity-60 text-sm">listed</span>
								<span class="text-sm font-medium" data-testid="inbox-card-item">{card.item}</span>
								<span class="ml-auto badge badge-sm">{inboxStateLabel(card.state)}</span>
							</div>
							<div class="flex items-center gap-3 flex-wrap text-xs opacity-80">
								<span>start <strong>${card.startingPrice}</strong></span>
								<span>reserve <strong>${card.reservePrice}</strong></span>
								<span data-testid="inbox-card-top">top <strong>${liveTop}</strong>{#if top}<span class="opacity-60"> by {top.bidderName}</span>{/if}</span>
								{#if card.state === 'pending' && !isOver}
									<span class="ml-auto font-mono" data-testid="inbox-card-countdown">{left}s left</span>
								{:else if card.state === 'pending' && isOver}
									<span class="ml-auto font-mono opacity-50">closing</span>
								{/if}
							</div>

							{#if card.state === 'pending'}
								<form onsubmit={(e) => { e.preventDefault(); submitBid(card, card.draftAmount) }} class="flex gap-2 items-center">
									<span class="text-xs opacity-60">your bid $</span>
									<!-- Compact on fine pointers, 44px floor where taps land. -->
									<input
										type="number"
										class="input input-bordered input-sm w-28 pointer-coarse:min-h-11"
										min={Math.max(1, (top ? top.amount + 1 : card.startingPrice))}
										max={caps.maxPrice}
										step="1"
										bind:value={card.draftAmount}
										data-testid="inbox-card-amount"
									/>
									<button
										type="submit"
										class="btn btn-sm btn-success pointer-coarse:min-h-11 pointer-coarse:min-w-11"
										disabled={isOver || !Number.isFinite(card.draftAmount) || card.draftAmount < (top ? top.amount + 1 : card.startingPrice)}
										data-testid="inbox-card-bid"
									>
										Bid ${card.draftAmount}
									</button>
									<button
										type="button"
										class="btn btn-sm btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11"
										onclick={() => passCard(card)}
										data-testid="inbox-card-pass"
									>
										Pass
									</button>
									{#if card.floorNotice}
										<span class="text-xs text-warning" data-testid="inbox-card-floor-note">{card.floorNotice}</span>
									{/if}
								</form>
							{:else if card.state === 'submitted'}
								<p class="text-xs" data-testid="inbox-card-submitted">
									You bid <strong>${card.myAmount}</strong>. Watching the race for
									{#if !isOver}<span class="font-mono">{left}s</span>{:else}closing{/if}.
								</p>
							{:else if card.state === 'passed'}
								<p class="text-xs">
									Passed. Watching the race for
									{#if !isOver}<span class="font-mono">{left}s</span>{:else}closing{/if}.
								</p>
							{:else if card.state === 'won'}
								<div class="flex items-center gap-2">
									<p class="text-sm flex-1" data-testid="inbox-card-outcome">
										You won <strong>{card.outcome?.item}</strong> for <strong>${card.outcome?.soldPrice}</strong>.
									</p>
									<button class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => dismissCard(card)} data-testid="inbox-card-dismiss">Dismiss</button>
								</div>
							{:else if card.state === 'outbid'}
								<div class="flex items-center gap-2">
									<p class="text-sm flex-1" data-testid="inbox-card-outcome">
										Sold to <strong>{card.outcome?.winnerName}</strong> at <strong>${card.outcome?.soldPrice}</strong>.
									</p>
									<button class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => dismissCard(card)} data-testid="inbox-card-dismiss">Dismiss</button>
								</div>
							{:else if card.state === 'no-sale'}
								<div class="flex items-center gap-2">
									<p class="text-sm flex-1" data-testid="inbox-card-outcome">
										No-sale (reserve not met).
									</p>
									<button class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => dismissCard(card)} data-testid="inbox-card-dismiss">Dismiss</button>
								</div>
							{:else if card.state === 'no-bidders'}
								<div class="flex items-center gap-2">
									<p class="text-sm flex-1" data-testid="inbox-card-outcome">
										Lot closed with no recipients.
									</p>
									<button class="btn btn-xs btn-ghost pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => dismissCard(card)} data-testid="inbox-card-dismiss">Dismiss</button>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<!-- Active lots: live waterfall -->
	<section class="card bg-base-100 border border-base-300" data-testid="active-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Active lots ({activeList.length})</h2>
			{#if activeList.length === 0}
				<p class="opacity-40 text-sm" data-testid="active-empty">
					No lots in flight. List one below to fan out a <code>live.push</code>
					to every connected tab.
				</p>
			{:else}
				<ul class="grid gap-3 @2xl:grid-cols-2" data-testid="active-list">
					{#each activeList as lot (lot.id)}
						{@const top = topBid(lot)}
						{@const left = secondsLeft(lot.deadlineAt)}
						{@const total = lot.durationSec}
						{@const elapsed = Math.max(0, Math.min(1, (nowMs - lot.startedAt) / (total * 1000)))}
						<li class="card bg-base-200 border border-base-300" data-testid="active-card">
							<div class="card-body py-3 space-y-2">
								<div class="flex items-center gap-2">
									<span class="inline-block w-2 h-2 rounded-full" style:background={lot.sellerColor}></span>
									<strong class="text-sm flex-1 truncate" data-testid="active-card-item">{lot.item}</strong>
									<span class="badge badge-sm badge-outline font-mono">{left}s</span>
								</div>
								<!-- Drains toward zero, matching the countdown badge's direction. -->
								<progress class="progress progress-primary w-full" value={1 - elapsed} max="1"></progress>
								<div class="flex items-center gap-2 text-xs opacity-70 flex-wrap">
									<span>by {lot.sellerName}</span>
									<span>start <strong>${lot.startingPrice}</strong></span>
									<span>reserve <strong>${lot.reservePrice}</strong></span>
									<span>{lot.recipientCount} bidder{lot.recipientCount === 1 ? '' : 's'}</span>
								</div>
								<div class="space-y-1">
									<div class="text-xs opacity-60">
										{#if top}
											Top: <strong data-testid="active-card-top">${top.amount}</strong>
											<span class="inline-block w-2 h-2 rounded-full align-middle ml-1" style:background={top.bidderColor}></span>
											<span>{top.bidderName}</span>
										{:else}
											<span data-testid="active-card-top">No bids yet</span>
										{/if}
									</div>
									{#if lot.bids.length > 0}
										<ul class="text-xs font-mono space-y-0.5 max-h-32 overflow-y-auto" data-testid="active-card-waterfall">
											{#each lot.bids.slice().sort((a, b) => b.ts - a.ts) as bid (bid.bidderId + ':' + bid.ts)}
												<li class="flex items-center gap-1" data-testid="active-card-bid">
													<span class="inline-block w-2 h-2 rounded-full" style:background={bid.bidderColor}></span>
													<span class="opacity-70 flex-1 truncate">{bid.bidderName}</span>
													<span><strong>${bid.amount}</strong></span>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<!-- List a Lot form -->
	<section class="card bg-base-200 {nothingLive ? 'order-first @2xl:order-none' : ''}" data-testid="list-section">
		<div class="card-body py-3 space-y-3">
			<h2 class="card-title text-sm">List a lot</h2>
			<form onsubmit={(e) => { e.preventDefault(); handleList() }} class="space-y-2">
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1 flex-1 min-w-0 @2xl:min-w-[14rem]">
						<span class="opacity-70 text-xs">Item</span>
						<input
							class="input input-bordered input-sm pointer-coarse:min-h-11"
							bind:value={item}
							placeholder="Vintage typewriter"
							maxlength={caps.maxItemLen}
							data-testid="list-item-input"
						/>
					</label>
				</div>
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1 flex-1 min-w-[8rem]">
						<span class="opacity-70 text-xs">Starting price ($)</span>
						<input
							type="number"
							class="input input-bordered input-sm pointer-coarse:min-h-11"
							min="0" max={caps.maxPrice} step="1"
							bind:value={startingPrice}
							data-testid="list-start-input"
						/>
					</label>
					<label class="flex flex-col gap-1 flex-1 min-w-[8rem]">
						<span class="opacity-70 text-xs">Reserve price ($)</span>
						<input
							type="number"
							class="input input-bordered input-sm pointer-coarse:min-h-11"
							min={startingPrice} max={caps.maxPrice} step="1"
							bind:value={reservePrice}
							data-testid="list-reserve-input"
						/>
						{#if Number.isFinite(reservePrice) && Number.isFinite(startingPrice) && reservePrice < startingPrice}
							<span class="text-xs text-error" data-testid="list-reserve-note">Reserve must be at least the starting price.</span>
						{/if}
					</label>
					<label class="flex flex-col gap-1 flex-1 min-w-[10rem]">
						<span class="opacity-70 text-xs">Duration ({durationSec}s)</span>
						<input
							type="range"
							class="range range-sm pointer-coarse:range-lg pointer-coarse:min-h-11"
							min={caps.minDurationSec} max={caps.maxDurationSec} step="1"
							bind:value={durationSec}
							data-testid="list-duration-input"
						/>
					</label>
				</div>
				<div class="flex items-center gap-2 flex-wrap">
					<button
						type="submit"
						class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						disabled={!canList}
						data-testid="list-submit"
					>
						{listing ? 'Listing...' : `List lot (${otherUsers.length} bidder${otherUsers.length === 1 ? '' : 's'})`}
					</button>
					<span class="text-xs opacity-60">
						You have {myActiveCount}/{caps.maxActivePerSeller} active lots.
					</span>
					{#if listHint}
						<span class="text-xs opacity-70" data-testid="list-hint">{listHint}</span>
					{/if}
					{#if formError}
						<span class="text-xs text-error" data-testid="list-error">{formError}</span>
					{/if}
				</div>
			</form>
			{#if lastResult}
				<div class="alert alert-success py-2" data-testid="list-result">
					<span class="text-sm" data-testid="list-result-text">{lastResultLabel(lastResult)}</span>
				</div>
			{/if}
		</div>
	</section>

	<!-- Recent results log -->
	<section class="card bg-base-100 border border-base-300" data-testid="recent-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Recent results ({recentList.length})</h2>
			{#if recentList.length === 0}
				<p class="opacity-40 text-sm" data-testid="recent-empty">Nothing yet.</p>
			{:else}
				<ul class="space-y-1 text-xs" data-testid="recent-list">
					{#each recentList as r (r.id)}
						<li class="flex items-center gap-2 flex-wrap" data-testid="recent-item">
							<span class="opacity-50 w-16">{timeAgo(r.closedAt)}</span>
							<span class="badge badge-sm {statusBadgeClass(r.status)}" data-testid="recent-status">{statusLabel(r.status)}</span>
							<span class="font-medium truncate" data-testid="recent-item-name">{r.item}</span>
							<span class="opacity-60">by {r.sellerName}</span>
							{#if r.status === 'sold'}
								<span class="ml-auto">
									<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={r.winnerColor}></span>
									<span class="font-medium" data-testid="recent-winner">{r.winnerName}</span>
									<span class="font-mono ml-1" data-testid="recent-price">${r.soldPrice}</span>
								</span>
							{:else}
								<span class="ml-auto opacity-50 font-mono">
									{r.bids.length} bid{r.bids.length === 1 ? '' : 's'}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>createAuction(args)</code> publishes the lot, then
			<code>Promise.allSettled(recipientIds.map((id) =&gt; live.push(&#123; userId: id &#125;, ...)))</code>.
			Each push that resolves with a valid <code>&#123; amount, bidderName, bidderColor &#125;</code>
			gets appended to <code>lot.bids</code> and a fresh <code>'updated'</code>
			event is published immediately, so spectators see the bid waterfall fill in real time.
		</p>
		<p>
			Client: <code>onPush(pushEvent, handler)</code> opens an unresolved
			Promise for each incoming bid request. The recipient's Bid / Pass
			click resolves the promise with the reply value; the value travels
			back to the server's awaiting <code>live.push</code> call.
			The card stays in a "submitted" state and shows the live top bid
			(reading from the same active-lots stream) until the lot closes
			and lands in recent results.
		</p>
	</aside>
</div>
