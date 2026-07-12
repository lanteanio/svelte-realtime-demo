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
		{ slug: 'schema-evolution',  title: 'Schema evolution: subscribe-time migrate hooks', desc: 'One stream at <code>version: 2</code> with <code>migrate: { 1: v1ToV2 }</code>. Two panels: a normal subscribe and one via <code>subscribeAt(stream, { schemaVersion: 1 })</code> from <code>svelte-realtime/testing/client</code> - the wire envelope claims v1, the server runs <code>migrate[1]</code> end-to-end, the migrated badge flips back to <code>loader</code> on each live publish.' },
		{ slug: 'flash-sales',       title: 'Flash sales: atomic inventory under contention', desc: 'Three products, limited stock, multi-tab race. <code>live.lock({ key, maxWaitMs }, ...)</code> serializes per-item buys FIFO so stock never goes negative; bursts past the bound surface as <code>LOCK_TIMEOUT</code>. Coupon claim rides <code>live.idempotent</code> keyed on userId for one-per-user enforcement.' },
		{ slug: 'pagination',        title: 'Pagination: cursor-based load-more',             desc: 'A log feed with 200 entries served in pages of 25. Loader returns <code>{ data, hasMore, cursor }</code>; client store exposes <code>loadMore()</code>. Live <code>\'created\'</code> publishes merge into the visible list regardless of which pages have been loaded.' },
		{ slug: 'effect',            title: 'Effects: server-side reactive side effects',     desc: 'An <code>orders</code> stream\'s publishes trigger a <code>live.effect([\'orders\'], handler)</code> that fans out to an audit feed and a notifications feed. Three streams in one page; the effect handler is fire-and-forget.' },
		{ slug: 'from-seq',          title: 'Reconnect: three-tier gap fill via delta.fromSeq', desc: 'A 1Hz event ticker; tab unsubscribes mid-flight; on resubscribe the server\'s bounded replay buffer covers short gaps and <code>delta.fromSeq(sinceSeq)</code> bridges to the durable store for older gaps. Each event is tagged with the tier that delivered it.' },
		{ slug: 'collab-editor',     title: 'Collab editor: CRDT selections vs raw offsets',  desc: 'Two <code>live.multiplayer</code> rooms share one <code>live.doc</code> textarea. Select a word in tab A, type before it in tab B: the <code>selections: \'offset\'</code> highlight drifts onto the wrong characters, the <code>selections: \'crdt\'</code> one re-anchors via <code>room.bindDoc(doc)</code> and stays glued.', since: '^0.6' },
		{ slug: 'multiplayer',       title: 'Multiplayer lounge: cursors, locks, typing, reactions', desc: 'One <code>live.multiplayer</code> room with every surface on: live cursors over a shared canvas via <code>room.move</code>, presence roster, an advisory <code>locks: [\'headline\']</code> input with lock-on-focus, <code>room.setTyping</code> indicator, and ephemeral emoji <code>room.react</code> emotes on a dedicated stream.', since: '^0.6' },
		{ slug: 'kanban',            title: 'Kanban: shared CRDT document',                    desc: 'One <code>live.doc</code>, zero RPC handlers. A <code>cards</code> map + one order array per column; moves ride <code>doc.transact()</code> as one atomic wire update. Concurrent moves from two tabs both survive, offline edits merge on reconnect - the local replica IS the offline queue.', since: '^0.6' },
		{ slug: 'offline',           title: 'Offline queue: post now, sync later',             desc: 'Guestbook whose posts survive losing the network. <code>configure({ offline: { queue, persist, persistKey } })</code> queues to IndexedDB across reloads; replay carries synthesized idempotency keys that the server\'s <code>live.idempotent</code> wrapper dedups, so entries land exactly once. Live <code>pendingMutations</code> / <code>uploading</code> / <code>offlineCheckpoint()</code> readouts.', since: '^0.6' },
		{ slug: 'arena',             title: 'Arena: area-of-interest culling',                 desc: 'A 2400x1600 world with 150 server-driven NPCs, but each client only receives its 420-unit neighbourhood: <code>live.smooth({ interest })</code> with LOD bands throttling the fringe. HUD shows the live receiving/total ratio; spectate mode pans the cull via <code>view.reportCenter</code>.', since: '^0.6' },
		{ slug: 'shooter',           title: 'Shooter: lag-compensated hits',                   desc: 'Click-to-shoot rays resolve against the world AS YOU RENDERED IT: <code>live.smooth({ hitTest })</code> rewinds each candidate to the shot\'s render-time stamp (server-measured uplink + interp, capped at <code>maxRewindMs: 400</code>). A 0-400ms latency slider delays your sends; aimed shots still land.', since: '^0.6' },
		{ slug: 'lobbies',           title: 'Lobbies: browse, own, share',                     desc: '<code>live.room</code> with <code>meta</code> + <code>enumerable</code> lights up a live lobby browser (<code>lobby.rooms()</code>); <code>owner: true</code> tracks the host role with deterministic succession and <code>ownerOnly</code> gates Close table server-side; <code>shortCodes()</code> mints each card\'s unguessable share code, decoded by a server RPC.', since: '^0.6' },
		{ slug: 'tenants',           title: 'Multi-tenancy: strict per-connection isolation',  desc: 'One scratchpad on one literal topic; <code>realtime({ tenant })</code> scopes everything the connection touches to <code>@t/&lt;id&gt;/...</code> at the wire layer. Handlers are byte-identical to a single-tenant app - only the app-owned Redis key names <code>ctx.tenantId</code>.', since: '^0.6' },
		{ slug: 'flags',             title: 'Feature flags: flip once, everywhere',            desc: 'Two <code>live.flag</code> declarations plus a validated <code>setFlag</code> RPC. Operator card flips a promo banner and a dark-launch rollout slider; every client updates instantly and fresh connects to any replica replay the cluster-latest value.', since: '^0.6' },
		{ slug: 'alarms',            title: 'Durable alarms: one-shot timers that survive restarts', desc: '<code>ctx.setAlarm(at)</code> arms a per-room one-shot; <code>onAlarm</code> fires with a fresh server ctx even if every tab is closed. Redis-backed <code>configureAlarm({ store, leader })</code> makes it survive worker restarts and fire exactly once cluster-wide; the fired log shows <code>lateMs</code> and a <code>recovered</code> badge when the recovery poll (not the precise timer) fired it.', since: '^0.6' },
		{ slug: 'forget',            title: 'Right to erasure: one call, every surface',       desc: 'Leave traces (app log, idempotency cache, presence, push), then <code>live.forget(ctx.user.id)</code> purges them cluster-wide and resolves only after the durable store confirms. The returned <code>surfaces</code> map renders as a per-surface erasure audit; the app-owned Redis half is deleted alongside.', since: '^0.6' },
		{ slug: 'privacy',           title: 'Aggregate privacy: k-anonymity + differential privacy', desc: 'One mood topic, two <code>live.aggregate</code> exports with identical reducers. Raw moves on every submission; the one with <code>privacy: { k: 3, strategy: \'hybrid\' }</code> holds its last published value below 3 distinct contributors per round and publishes with seeded Laplace noise at k - the k-drop itself stays invisible.', since: '^0.6' },
		{ slug: 'ops',               title: 'Ops: the introspection dashboard',                desc: 'One <code>introspect()</code> call rendered as an ops panel - connections, in-flight work, topic load, handlers by kind, push registry, admission posture, and the DLQ summary. Counts-only and PII-free by design, polled while visible; the auth-gated <code>/__realtime</code> admin plane serves the same snapshot over HTTP.', since: '^0.6' },
		{ slug: 'outbound-webhooks', title: 'Outbound webhooks: sign, retry, dead-letter, replay', desc: '<code>live.webhooks.outbound</code> POSTs an HMAC-signed body with an <code>idempotency-key</code> to a sink on every publish - leader-gated, fleet-shared retry budget and breaker. Place a failing order to watch retries exhaust into the cluster-shared Redis DLQ, then replay the original payload.', since: '^0.6' },
		{ slug: 'phases',            title: 'Phases: attach lifecycle + atomic publish batch', desc: 'Drive a stream\'s attach machine by hand - <code>attach()</code> holds it open with no UI subscriber, <code>detach()</code> means done - with the <code>phase</code> badge live. Then prove <code>ctx.batch(fn)</code> drops every buffered publish on a throw, even across an await boundary.', since: '^0.6' }
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
							<span class="badge badge-xs badge-outline absolute top-2 right-2 normal-case font-mono" data-testid="tile-version">{d.since ?? '^0.5'}</span>
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
