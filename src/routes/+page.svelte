<!--
	Home page -- board list with create form.

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
		<h2 class="text-lg font-bold mb-1">0.5.0 demos</h2>
		<p class="text-xs opacity-50 mb-4">Focused single-feature reproducers from the 0.5.0 line.</p>
		<ul class="grid gap-2">
			<li>
				<a href="/demos/checkout" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Idempotency under double-click</div>
						<div class="text-xs opacity-60">Five rapid RPCs, one effect. <code>live.idempotent</code>.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/counter-resume" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Reconnect-resume with no flicker</div>
						<div class="text-xs opacity-60">Drop network 10s, reconnect, no refetch. Session resume + replay buffer.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/chat" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Chat rooms with presence + denials</div>
						<div class="text-xs opacity-60"><code>live.room</code> bundles messages and presence; <code>live.idempotent</code> on send; FORBIDDEN banner on the members-only room.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/todos-rollback" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Optimistic mutate with rollback</div>
						<div class="text-xs opacity-60"><code>rpc.createOptimistic</code> + force-fail toggle. Spam x5 with force-fail on; placeholders roll back independently.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/denials" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Subscribe denials with org switcher</div>
						<div class="text-xs opacity-60">Two orgs (Acme / Globex), one identity cookie. Cross-org subscribes return <code>FORBIDDEN</code> at the wire gate.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/pressure" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Admission-shedding control panel</div>
						<div class="text-xs opacity-60">Live <code>platform.pressure</code> readout + sparkline + load generator + shed log.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/chaos" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Deterministic chaos</div>
						<div class="text-xs opacity-60">Seed + drop rate, fully reproducible. Same inputs, same green/red pattern.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/notifications" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Push, reply, schedule</div>
						<div class="text-xs opacity-60"><code>live.push</code> request/reply across users, cluster registry wiring, and a 6-field <code>live.cron</code> tick draining the schedule queue.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/topk" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Top-K leaderboards: four windows, one config</div>
						<div class="text-xs opacity-60"><code>live.aggregate(&#123; windows &#125;)</code> with sliding, tumbling, and lifetime slices in parallel. Speed slider + bias controls drive the visual diff between window types.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/news" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Newsroom: cron + windowed aggregate + derived + webhook</div>
						<div class="text-xs opacity-60">Four primitives in one page. <code>live.cron</code> firehose feeds <code>live.aggregate(&#123; windows &#125;)</code>; <code>live.derived</code> tracks stats; HMAC-signed Publish form round-trips through <code>live.webhook</code>.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/jobs" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Jobs: durable task runner with fence + retry + force-takeover</div>
						<div class="text-xs opacity-60">Postgres-backed <code>createTaskRunner</code> with Redis fence, retry policy, idempotency cache, and force-takeover. <code>live.cron</code> tick polls the table and fans out the row list + status counts.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/cluster-cron" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Cluster cron: one leader, one tick</div>
						<div class="text-xs opacity-60">Redis-backed leader election visualised. <code>createLeader</code> + <code>live.configureCron(&#123; leader &#125;)</code> gate a 1Hz <code>live.cron</code> so it fires once cluster-wide instead of once per worker.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/upload" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Upload: streaming uploads with content-addressed dedup</div>
						<div class="text-xs opacity-60">Streaming file uploads via <code>live.upload</code> (next.13). SHA-256 chunk hashes go through <code>redis/idempotency</code> so re-uploads skip storage; <code>live.notify(&#123; userId &#125;)</code> fires a fire-and-forget push to the same user's other tabs when a file lands.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/auctions" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Auctions: deadline-bounded bid race</div>
						<div class="text-xs opacity-60">List a lot, server fans out <code>live.push</code> to every other tab in parallel, <code>Promise.allSettled</code> collects every reply by the deadline. Each accepted bid <code>ctx.publish</code>es 'updated' on the active stream so the waterfall fills in real time.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/schema-evolution" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Schema evolution: subscribe-time migrate hooks</div>
						<div class="text-xs opacity-60">One stream at <code>version: 2</code> with <code>migrate: &#123; 1: v1ToV2 &#125;</code>. Two panels: a normal subscribe and one via <code>subscribeAt(stream, &#123; schemaVersion: 1 &#125;)</code> from <code>svelte-realtime/test-client</code> -- the wire envelope claims v1, the server runs <code>migrate[1]</code> end-to-end, the migrated badge flips back to <code>loader</code> on each live publish.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/flash-sales" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Flash sales: atomic inventory under contention</div>
						<div class="text-xs opacity-60">Three products, limited stock, multi-tab race. <code>live.lock(&#123; key, maxWaitMs &#125;, ...)</code> serializes per-item buys FIFO so stock never goes negative; bursts past the bound surface as <code>LOCK_TIMEOUT</code>. Coupon claim rides <code>live.idempotent</code> keyed on userId for one-per-user enforcement.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/pagination" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Pagination: cursor-based load-more</div>
						<div class="text-xs opacity-60">A log feed with 200 entries served in pages of 25. Loader returns <code>&#123; data, hasMore, cursor &#125;</code>; client store exposes <code>loadMore()</code>. Live <code>'created'</code> publishes merge into the visible list regardless of which pages have been loaded.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/effect" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Effects: server-side reactive side effects</div>
						<div class="text-xs opacity-60">An <code>orders</code> stream's publishes trigger a <code>live.effect(['orders'], handler)</code> that fans out to an audit feed and a notifications feed. Three streams in one page; the effect handler is fire-and-forget.</div>
					</div>
				</a>
			</li>
			<li>
				<a href="/demos/from-seq" class="card card-compact bg-base-200 hover:bg-base-300 transition-colors">
					<div class="card-body">
						<div class="font-semibold">Reconnect: three-tier gap fill via delta.fromSeq</div>
						<div class="text-xs opacity-60">A 1Hz event ticker; tab unsubscribes mid-flight; on resubscribe the server's bounded replay buffer covers short gaps and <code>delta.fromSeq(sinceSeq)</code> bridges to the durable store for older gaps. Each event is tagged with the tier that delivered it.</div>
					</div>
				</a>
			</li>
		</ul>
	</section>
</div>
