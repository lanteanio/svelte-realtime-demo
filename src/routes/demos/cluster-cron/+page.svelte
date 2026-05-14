<!--
	/demos/cluster-cron - Redis-backed leader election visualised live.

	Two prod servers, same Redis: one of them holds the cluster lease,
	the other waits. The 1Hz live.cron registered in $live/demos/cluster-cron
	is gated cluster-wide by live.configureCron({ leader }) so only the
	leader fires per second. The recent-tick log shows which instanceId
	owns the lease at any moment; if the leader's process exits, the lease
	expires within the renew window (10s) and a sibling takes over - the
	tick log seamlessly switches to the new instanceId.

	To exercise the takeover, run two prod servers on different ports
	pointing at the same Redis (see the panel below for the exact command).
-->
<script>
	import { onMount } from 'svelte'
	import { clusterTicks, myClusterCronState } from '$live/demos/cluster-cron'

	let myInstanceId = $state('')
	let leaseKey = $state('')
	let isLeaderNow = $state(false)
	let tickCap = $state(30)

	let ticks = $state([])

	$effect(() => {
		const off = clusterTicks.subscribe((v) => { ticks = v ?? [] })
		return () => off()
	})

	onMount(async () => {
		const s = await myClusterCronState()
		myInstanceId = s?.instanceId ?? ''
		leaseKey = s?.leaseKey ?? ''
		isLeaderNow = !!s?.isLeader
		tickCap = s?.tickCap ?? 30
	})

	const sortedTicks = $derived(
		[...ticks].sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0))
	)

	const latestTick = $derived(sortedTicks[0] ?? null)

	const currentLeaderId = $derived(latestTick?.instanceId ?? null)

	const seenInstanceIds = $derived.by(() => {
		const seen = new Set()
		for (const t of ticks) if (t?.instanceId) seen.add(t.instanceId)
		if (myInstanceId) seen.add(myInstanceId)
		return [...seen]
	})

	function fmtTime(ts) {
		if (!ts) return ''
		const d = new Date(ts)
		if (Number.isNaN(d.getTime())) return ''
		return d.toLocaleTimeString()
	}

	function shortId(id) {
		if (typeof id !== 'string' || id.length === 0) return ''
		return id.length <= 10 ? id : id.slice(0, 8) + '...'
	}
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Cluster cron: one leader, one tick</h1>
		<p class="text-sm opacity-70 mt-1">
			Redis-backed leader election visualised. <code>createLeader</code> elects exactly one worker
			across the cluster; <code>live.configureCron(&#123; leader &#125;)</code> gates every cron tick
			on the lease so a 1Hz <code>live.cron</code> fires once per second cluster-wide instead of
			once per worker.
		</p>
	</header>

	<div class="card bg-base-200" data-testid="cluster-cron-self-panel">
		<div class="card-body py-3 space-y-2">
			<div class="flex flex-wrap gap-3 items-baseline justify-between">
				<div>
					<div class="text-xs opacity-60">This instance</div>
					<div class="font-mono text-sm" data-testid="self-instance-id">{myInstanceId || '...'}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Lease key</div>
					<div class="font-mono text-xs opacity-80" data-testid="lease-key">{leaseKey || '...'}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Initial leader status</div>
					<div data-testid="self-leader-status">
						{#if isLeaderNow}
							<span class="badge badge-primary" data-testid="self-leader-badge">leader</span>
						{:else}
							<span class="badge badge-ghost">follower</span>
						{/if}
					</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Current cron leader</div>
					<div class="font-mono text-sm" data-testid="current-leader-id">
						{currentLeaderId ? shortId(currentLeaderId) : '...'}
					</div>
				</div>
			</div>
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<div class="card bg-base-100 border border-base-300 lg:col-span-2" data-testid="cluster-cron-ticks">
			<div class="card-body py-3 space-y-2">
				<div class="flex justify-between items-baseline">
					<h2 class="card-title text-sm">Recent ticks (newest first)</h2>
					<span class="text-xs opacity-50">cap {tickCap}</span>
				</div>
				{#if sortedTicks.length === 0}
					<p class="opacity-40 text-xs py-3" data-testid="cluster-cron-ticks-empty">
						Waiting for the first cron tick...
					</p>
				{:else}
					<ul class="space-y-1 max-h-96 overflow-y-auto pr-1" data-testid="cluster-cron-ticks-list">
						{#each sortedTicks as tick (tick.id)}
							<li
								class="flex items-center gap-2 text-xs border-b border-base-200 last:border-0 pb-1"
								data-testid="cluster-cron-tick-row"
								data-instance-id={tick.instanceId ?? ''}
							>
								<span class="font-mono opacity-50 w-12 text-right" data-testid="tick-seq">#{tick.seq ?? ''}</span>
								<span class="font-mono opacity-70 w-20" data-testid="tick-time">{fmtTime(tick.ts)}</span>
								<span class="badge badge-sm" class:badge-primary={tick.instanceId === myInstanceId} class:badge-ghost={tick.instanceId !== myInstanceId} data-testid="tick-instance-id">
									{shortId(tick.instanceId)}
								</span>
								{#if tick.instanceId === myInstanceId}
									<span class="text-xs opacity-50">(this instance)</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300" data-testid="cluster-cron-instances">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Instances seen</h2>
				{#if seenInstanceIds.length === 0}
					<p class="opacity-40 text-xs">Waiting...</p>
				{:else}
					<ul class="space-y-1" data-testid="cluster-cron-instances-list">
						{#each seenInstanceIds as id (id)}
							<li class="flex items-center gap-2 text-xs" data-testid="cluster-cron-instance-row">
								<span class="font-mono flex-1 truncate">{shortId(id)}</span>
								{#if id === currentLeaderId}
									<span class="badge badge-xs badge-primary" data-testid="instance-leader-badge">leader</span>
								{:else if id === myInstanceId}
									<span class="badge badge-xs badge-ghost">self</span>
								{:else}
									<span class="badge badge-xs badge-outline">follower</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>

	<div class="card bg-warning/10 border border-warning/40" data-testid="cluster-cron-instructions">
		<div class="card-body py-3 space-y-2 text-xs">
			<h2 class="card-title text-sm">See the takeover</h2>
			<p class="opacity-80 leading-snug">
				Single-instance dev shows one steady leader (this worker is always elected). To watch a real
				cluster transition, start a second prod server on a different port pointing at the same Redis:
			</p>
			<pre class="bg-base-300 p-2 rounded text-xs overflow-x-auto"><code>npm run build
DATABASE_URL=postgres://postgres:postgres@localhost:5434/stickynotes \
  REDIS_URL=redis://localhost:6380 \
  PORT=3021 HOST=127.0.0.1 \
  node build/index.js</code></pre>
			<p class="opacity-80 leading-snug">
				Open both <code>http://127.0.0.1:3020/demos/cluster-cron</code> and
				<code>http://127.0.0.1:3021/demos/cluster-cron</code>. The recent-tick log on both pages should
				show the SAME instanceId (the elected leader). Stop one server with Ctrl-C; within ten seconds
				(<code>renewMs</code>) the surviving sibling acquires the lease and the log on the live page
				flips to the new instanceId.
			</p>
			<p class="opacity-60 leading-snug">
				The <code>/metrics</code> endpoint exposes <code>leader_acquired_total</code>,
				<code>leader_renewals_total</code>, <code>leader_lost_total</code>, and
				<code>svelte_realtime_cron_total&#123;status&#125;</code>. Scrape both servers during the
				takeover window and the counters tell the same story the page shows.
			</p>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Mechanism: <code>SET &lt;key&gt; &lt;instanceId&gt; NX PX &lt;leaseMs&gt;</code> to acquire,
			Lua-atomic compare-and-pexpire to renew, Lua-atomic compare-and-delete to release. The
			compare-on-mutate guard means a stale renewal from a worker that already lost leadership cannot
			extend somebody else's lease.
		</p>
		<p>
			Failure model: fail-closed. A renewal that throws (Redis disconnect, breaker open, network
			partition) drops <code>_isLeader</code> to false and the cron tick skips with a
			<code>cron&#123;status:'not-leader'&#125;</code> metric increment until the next renew succeeds.
			Across the cluster a partitioned Redis means the lease expires server-side and no worker holds
			leadership until the partition heals - jobs miss ticks rather than double-fire.
		</p>
		<p>
			GC pause caveat: a long stop-the-world pause on the leader can cause brief overlap with a
			freshly-elected successor. Recommend job idempotency at the consumer; this primitive does not
			provide fencing tokens (consumer sinks for cron-style work rarely have the machinery to consume
			them anyway). For the durable-task case, see <a href="/demos/jobs" class="link">/demos/jobs</a>.
		</p>
	</aside>
</div>
