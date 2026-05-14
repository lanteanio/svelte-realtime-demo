<!--
	Home page - board list with create form.

	Boards are sorted by activity: boards with the most users online
	appear first. Boards with equal presence are sorted by most
	recently active. This way the most interesting boards bubble up.

	Creating a board: type a name, hit Create. The RPC runs over
	WebSocket, generates a random slug, inserts into the database,
	and publishes a 'created' event. Every other user's board list
	updates instantly. Then we navigate to the new board.
-->
<script>
	import { boards, createBoard } from '$live/boards'
	import { goto } from '$app/navigation'
	import BoardCard from '$lib/components/BoardCard.svelte'

	let newTitle = $state('')

	// Track presence count per board. Each BoardCard reports its
	// count back here via the onpresence callback. We use this
	// to sort boards by activity (most users first).
	let presenceCounts = $state({})

	const sortedBoards = $derived.by(() => {
		const list = $boards
		if (!list) return undefined
		return [...list].sort((a, b) => {
			const countA = presenceCounts[a.board_id] || 0
			const countB = presenceCounts[b.board_id] || 0
			if (countA !== countB) return countB - countA
			const timeA = new Date(a.last_activity).getTime() || 0
			const timeB = new Date(b.last_activity).getTime() || 0
			return timeB - timeA
		})
	})

	async function handleCreate(e) {
		e.preventDefault()
		if (!newTitle.trim()) return
		// idempotencyKey: a double-click or flaky-reconnect retry with the
		// same key returns the same board instead of creating duplicates.
		const idempotencyKey = crypto.randomUUID()
		const board = await createBoard.with({ idempotencyKey })(newTitle)
		newTitle = ''
		goto(`/board/${board.slug}`)
	}

	// Demos catalog. Iterated below and filtered live by the search
	// input. Descriptions hold inline <code> markup, so they render
	// via {@html}; content is hardcoded here so no XSS concern.
	const DEMOS = [
		{ slug: 'checkout',          title: 'Idempotency under double-click',                 desc: 'Five rapid RPCs, one effect. <code>live.idempotent</code>.' },
		{ slug: 'counter-resume',    title: 'Reconnect-resume with no flicker',               desc: 'Drop network 10s, reconnect, no refetch. Session resume + replay buffer.' },
		{ slug: 'chat',              title: 'Chat rooms with presence + denials',             desc: '<code>live.room</code> bundles messages and presence; <code>live.idempotent</code> on send; FORBIDDEN banner on the members-only room.' },
		{ slug: 'todos-rollback',    title: 'Optimistic mutate with rollback',                desc: '<code>rpc.createOptimistic</code> + force-fail toggle. Spam x5 with force-fail on; placeholders roll back independently.' },
		{ slug: 'denials',           title: 'Subscribe denials with org switcher',            desc: 'Two orgs (Acme / Globex), one identity cookie. Cross-org subscribes return <code>FORBIDDEN</code> at the wire gate.' },
		{ slug: 'pressure',          title: 'Admission-shedding control panel',               desc: 'Live <code>platform.pressure</code> readout + sparkline + load generator + shed log.' },
		{ slug: 'chaos',             title: 'Deterministic chaos',                            desc: 'Seed + drop rate, fully reproducible. Same inputs, same green/red pattern.' },
		{ slug: 'notifications',     title: 'Push, reply, schedule',                          desc: '<code>live.push</code> request/reply across users, cluster registry wiring, and a 6-field <code>live.cron</code> tick draining the schedule queue.' },
		{ slug: 'topk',              title: 'Top-K leaderboards: four windows, one config',   desc: '<code>live.aggregate({ windows })</code> with sliding, tumbling, and lifetime slices in parallel. Speed slider + bias controls drive the visual diff between window types.' },
		{ slug: 'news',              title: 'Newsroom: cron + windowed aggregate + derived + webhook', desc: 'Four primitives in one page. <code>live.cron</code> firehose feeds <code>live.aggregate({ windows })</code>; <code>live.derived</code> tracks stats; HMAC-signed Publish form round-trips through <code>live.webhook</code>.' },
		{ slug: 'jobs',              title: 'Jobs: durable task runner with fence + retry + force-takeover', desc: 'Postgres-backed <code>createTaskRunner</code> with Redis fence, retry policy, idempotency cache, and force-takeover. <code>live.cron</code> tick polls the table and fans out the row list + status counts.' },
		{ slug: 'cluster-cron',      title: 'Cluster cron: one leader, one tick',             desc: 'Redis-backed leader election visualised. <code>createLeader</code> + <code>live.configureCron({ leader })</code> gate a 1Hz <code>live.cron</code> so it fires once cluster-wide instead of once per worker.' },
		{ slug: 'upload',            title: 'Upload: streaming uploads with content-addressed dedup', desc: 'Streaming file uploads via <code>live.upload</code>. SHA-256 chunk hashes go through <code>redis/idempotency</code> so re-uploads skip storage; <code>live.notify({ userId })</code> fires a fire-and-forget push to the same user\'s other tabs when a file lands.' },
		{ slug: 'auctions',          title: 'Auctions: deadline-bounded bid race',            desc: 'List a lot, server fans out <code>live.push</code> to every other tab in parallel, <code>Promise.allSettled</code> collects every reply by the deadline. Each accepted bid <code>ctx.publish</code>es \'updated\' on the active stream so the waterfall fills in real time.' },
		{ slug: 'schema-evolution',  title: 'Schema evolution: subscribe-time migrate hooks', desc: 'One stream at <code>version: 2</code> with <code>migrate: { 1: v1ToV2 }</code>. Two panels: a normal subscribe and one via <code>subscribeAt(stream, { schemaVersion: 1 })</code> from <code>svelte-realtime/test-client</code> - the wire envelope claims v1, the server runs <code>migrate[1]</code> end-to-end, the migrated badge flips back to <code>loader</code> on each live publish.' },
		{ slug: 'flash-sales',       title: 'Flash sales: atomic inventory under contention', desc: 'Three products, limited stock, multi-tab race. <code>live.lock({ key, maxWaitMs }, ...)</code> serializes per-item buys FIFO so stock never goes negative; bursts past the bound surface as <code>LOCK_TIMEOUT</code>. Coupon claim rides <code>live.idempotent</code> keyed on userId for one-per-user enforcement.' },
		{ slug: 'pagination',        title: 'Pagination: cursor-based load-more',             desc: 'A log feed with 200 entries served in pages of 25. Loader returns <code>{ data, hasMore, cursor }</code>; client store exposes <code>loadMore()</code>. Live <code>\'created\'</code> publishes merge into the visible list regardless of which pages have been loaded.' },
		{ slug: 'effect',            title: 'Effects: server-side reactive side effects',     desc: 'An <code>orders</code> stream\'s publishes trigger a <code>live.effect([\'orders\'], handler)</code> that fans out to an audit feed and a notifications feed. Three streams in one page; the effect handler is fire-and-forget.' },
		{ slug: 'from-seq',          title: 'Reconnect: three-tier gap fill via delta.fromSeq', desc: 'A 1Hz event ticker; tab unsubscribes mid-flight; on resubscribe the server\'s bounded replay buffer covers short gaps and <code>delta.fromSeq(sinceSeq)</code> bridges to the durable store for older gaps. Each event is tagged with the tier that delivered it.' }
	]

	let demoFilter = $state('')

	function stripTags(s) {
		return s.replace(/<[^>]*>/g, '')
	}

	const filteredDemos = $derived.by(() => {
		const q = demoFilter.trim().toLowerCase()
		if (!q) return DEMOS
		return DEMOS.filter((d) => {
			const hay = (d.slug + ' ' + d.title + ' ' + stripTags(d.desc)).toLowerCase()
			return hay.includes(q)
		})
	})
</script>

<div class="max-w-xl mx-auto p-8">
	<h1 class="text-2xl font-bold mb-2">Boards</h1>
	<p class="text-sm opacity-50 mb-6">Pick a board or create a new one. No login needed. Boards expire after 1 hour of inactivity.</p>

	<form onsubmit={handleCreate} class="flex gap-2 mb-6">
		<input
			class="input flex-1"
			bind:value={newTitle}
			placeholder="New board name..."
		/>
		<button type="submit" class="btn btn-primary">Create</button>
	</form>

	{#if sortedBoards === undefined}
		<div class="flex justify-center py-8">
			<span class="loading loading-spinner"></span>
		</div>
	{:else}
		<div class="grid gap-3">
			{#each sortedBoards as board (board.board_id)}
				<BoardCard {board} onpresence={(count) => presenceCounts[board.board_id] = count} />
			{/each}
			{#if sortedBoards.length === 0}
				<p class="text-center opacity-40 py-8">No boards yet. Create the first one.</p>
			{/if}
		</div>
	{/if}

	<section class="mt-12">
		<h2 class="text-lg font-bold mb-1">Demos</h2>
		<p class="text-xs opacity-50 mb-3">Focused single-feature reproducers. Each tile is tagged with its minimum <code>svelte-realtime</code> version requirement.</p>
		<div class="flex items-center gap-2 mb-3">
			<input
				type="search"
				class="input input-sm input-bordered flex-1"
				placeholder="Filter demos (try 'lock', 'push', 'cron')..."
				bind:value={demoFilter}
				data-testid="demos-filter"
				autocomplete="off"
			/>
			<span class="text-xs opacity-50 tabular-nums" data-testid="demos-filter-count">
				{filteredDemos.length} / {DEMOS.length}
			</span>
		</div>
		<ul class="grid gap-2" data-testid="demos-list">
			{#each filteredDemos as d (d.slug)}
				<li>
					<a href="/demos/{d.slug}" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors relative" data-testid="demos-tile-{d.slug}">
						<div class="card-body">
							<span class="badge badge-xs badge-outline absolute top-2 right-2 normal-case font-mono" data-testid="tile-version">^0.5</span>
							<div class="font-semibold">{d.title}</div>
							<div class="text-xs opacity-60">{@html d.desc}</div>
						</div>
					</a>
				</li>
			{:else}
				<li class="opacity-50 text-sm text-center py-6" data-testid="demos-empty">
					No demos match "{demoFilter}".
				</li>
			{/each}
		</ul>
	</section>
</div>
