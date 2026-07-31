<!--
	/demos/jobs - durable Postgres-backed task runner with Redis fence,
	retry policy, force-takeover, and live polling via live.cron.

	Pick a duration + outcome mode. Click Enqueue. The task lands in
	Postgres; the runner's dispatch sweep claims it within ~1s and
	starts running the registered handler. Watch the row transition
	pending -> running -> committed/failed.

	On a running row, click Force takeover. We expire the fence in
	Postgres (and the demo's force-takeover RPC also gives the recovery
	sweep a head start). The original handler's heartbeat sees the
	fence drift and aborts; the recovery sweep rearms the row with a
	new fence; if mode = fail-once and we're past attempt 1, it commits.

	Powered by createTaskRunner + createRedisFence + createIdempotencyStore
	+ live.cron, all wired in src/lib/server/tasks.js.
-->
<script>
	import { onMount } from 'svelte'
	import { confirmDestructive } from '$lib/confirm-destructive'
	import {
		jobsList,
		jobsStats,
		enqueueJob,
		forceTakeover,
		clearJobs,
		myJobsState
	} from '$live/demos/jobs'

	let available = $state(true)
	let fenceEnabled = $state(false)
	let modes = $state(['succeed', 'fail-once', 'fail-always'])

	let list = $state([])
	let stats = $state({ pending: 0, running: 0, committed: 0, failed: 0, total: 0 })

	let durationSec = $state(2)
	let mode = $state('succeed')
	let busy = $state(false)
	let lastError = $state('')
	let clearError = $state('')
	// Takeover failures land on the row that caused them, not in the form.
	let rowErrors = $state({})
	// Liveness: when the 1Hz stats tick last arrived.
	let lastTickAt = $state(0)

	$effect(() => {
		const offs = [
			jobsList.subscribe((v) => { list = Array.isArray(v) ? v : [] }),
			// Only a real snapshot counts as a tick. The store emits undefined
			// synchronously on subscribe, and stamping that moment claimed a live
			// 1Hz tick before the stream had delivered anything at all.
			jobsStats.subscribe((v) => {
				if (v == null) return
				stats = v
				lastTickAt = Date.now()
			})
		]
		return () => { for (const off of offs) off() }
	})

	// Every enqueue carries a generated idempotency key; the runner stores it
	// on the row. Enqueue-level dedup (same key returning the original task)
	// is not part of the shipped enqueue contract yet, so the page makes no
	// claim it cannot demonstrate.

	onMount(async () => {
		const s = await myJobsState()
		available = Boolean(s?.available)
		fenceEnabled = Boolean(s?.fenceEnabled)
		modes = Array.isArray(s?.modes) ? s.modes : modes
	})

	async function handleEnqueue(e) {
		e.preventDefault()
		if (busy || !available) return
		busy = true
		lastError = ''
		try {
			await enqueueJob({
				durationMs: Math.round(durationSec * 1000),
				mode,
				idempotencyKey: crypto.randomUUID()
			})
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			busy = false
		}
	}

	async function handleForceTakeover(taskId) {
		if (!available) return
		try {
			await forceTakeover(taskId)
			if (rowErrors[taskId]) {
				const { [taskId]: gone, ...rest } = rowErrors
				rowErrors = rest
			}
		} catch (err) {
			rowErrors = { ...rowErrors, [taskId]: err?.message ?? String(err) }
		}
	}

	async function handleClear() {
		if (!available) return
		if (!confirmDestructive('Clear all shared jobs?')) return
		clearError = ''
		try {
			await clearJobs()
		} catch (err) {
			// Scoped to the Clear control's own surface: routing this into
			// lastError put a clear-all failure inside the enqueue form, which
			// had nothing to do with it.
			clearError = err?.message ?? String(err)
		}
	}

	function fmtTime(ms) {
		if (!ms) return ''
		return new Date(ms).toLocaleTimeString()
	}

	function statusColor(status) {
		if (status === 'committed') return 'badge-success'
		if (status === 'failed') return 'badge-error'
		if (status === 'running') return 'badge-info'
		return 'badge-ghost'
	}

	function summarizeInput(input) {
		if (!input) return ''
		const dur = input.durationMs ? `${(input.durationMs / 1000).toFixed(1)}s` : ''
		const m = input.mode ? input.mode : ''
		return [dur, m].filter(Boolean).join(' / ')
	}
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Jobs: durable task runner with fence + retry + force-takeover</h1>
		<p class="text-sm opacity-70 mt-1">
			Postgres-backed task framework via <code>createTaskRunner</code>. Per-attempt fence in
			Postgres + an optional Redis mirror via <code>createRedisFence</code>.
			<code>live.cron</code> runs a 1Hz refresh tick that
			polls the table and publishes both the row list and a stats snapshot.
		</p>
	</header>

	{#if !available}
		<div class="alert alert-warning" data-testid="jobs-unavailable">
			<div>
				<h2 class="font-bold">Postgres required</h2>
				<p class="text-xs opacity-80">
					This demo needs <code>DATABASE_URL</code> wired to a running Postgres instance.
					The repo's <code>.env</code> points at <code>localhost:5434</code>; make sure the
					<code>srdemo-pg</code> container is up (<code>docker start srdemo-pg</code>).
				</p>
			</div>
		</div>
	{:else}
		<div class="card bg-base-200" data-testid="jobs-stats-strip">
			<div class="card-body py-3 grid grid-cols-2 @2xl:grid-cols-3 @3xl:grid-cols-5 gap-3 text-sm">
				<div>
					<div class="text-xs opacity-60">Pending</div>
					<div class="font-mono text-lg" data-testid="stat-pending">{stats.pending}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Running</div>
					<div class="font-mono text-lg" data-testid="stat-running">{stats.running}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Committed</div>
					<div class="font-mono text-lg" data-testid="stat-committed">{stats.committed}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Failed</div>
					<div class="font-mono text-lg" data-testid="stat-failed">{stats.failed}</div>
				</div>
				<div>
					<div class="text-xs opacity-60">Total</div>
					<div class="font-mono text-lg" data-testid="stat-total">{stats.total}</div>
				</div>
				<!-- Liveness at a glance, even with every counter at zero. -->
				<div class="col-span-full text-right text-[10px] opacity-60" data-testid="jobs-last-tick">
					{lastTickAt > 0 ? `last tick ${fmtTime(lastTickAt)}` : 'waiting for the first 1Hz tick...'}
				</div>
			</div>
		</div>

		<form class="card bg-base-100 border border-base-300" onsubmit={handleEnqueue} data-testid="jobs-enqueue-form">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Enqueue simulate-work</h2>
				<div class="flex flex-wrap gap-3 items-end">
					<label class="flex flex-col gap-1 flex-1 min-w-[10rem]">
						<span class="opacity-70 text-xs">Duration ({durationSec.toFixed(1)}s)</span>
						<input
							type="range"
							class="range range-sm pointer-coarse:range-lg pointer-coarse:min-h-11"
							min="0.4" max="15" step="0.1"
							bind:value={durationSec}
							data-testid="jobs-duration-input"
						/>
						<div class="flex justify-between text-[10px] opacity-60">
							<span>0.4s</span>
							<span>15s</span>
						</div>
					</label>
					<label class="flex flex-col gap-1 min-w-[12rem]">
						<span class="opacity-70 text-xs">Mode</span>
						<select class="select select-sm select-bordered" bind:value={mode} data-testid="jobs-mode-input">
							{#each modes as m (m)}
								<option value={m}>{m}</option>
							{/each}
						</select>
					</label>
					<button
						type="submit"
						class="btn btn-primary btn-sm"
						disabled={busy}
						data-testid="jobs-enqueue-button"
					>
						{busy ? 'Enqueuing...' : 'Enqueue'}
					</button>
				</div>
				<p class="text-xs opacity-60">
					Fence mirror in Redis: <span data-testid="fence-status">{fenceEnabled ? 'enabled' : 'disabled (no REDIS_URL)'}</span>.
					Retry policy: 3 attempts with linear backoff (250ms x attempt).
				</p>
				{#if lastError}
					<p class="text-xs text-error" data-testid="jobs-error">{lastError}</p>
				{/if}
			</div>
		</form>

		<div class="card bg-base-100 border border-base-300" data-testid="jobs-list">
			<div class="card-body py-3 space-y-2">
				<!-- Clear all lives with the list it clears, not in the enqueue
				     form, and reports its own failures here rather than into the
				     unrelated form's error slot. -->
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 class="card-title text-sm">Recent tasks ({list.length})</h2>
					<button
						type="button"
						class="btn btn-outline btn-error btn-sm pointer-coarse:min-h-11"
						onclick={handleClear}
						data-testid="jobs-clear-button"
					>
						Clear all
					</button>
				</div>
				{#if clearError}
					<p class="text-xs text-error" data-testid="jobs-clear-error">{clearError}</p>
				{/if}
				{#if list.length === 0}
					<p class="text-base-content/70 text-xs" data-testid="jobs-list-empty">
						No tasks yet. Enqueue one above - try a 10s duration so you have
						time to press Force takeover while it runs.
					</p>
				{:else}
					<ul class="space-y-2 max-h-96 overflow-y-auto pr-1">
						{#each list as job (job.id)}
							<li
								class="border-b border-base-200 pb-2 last:border-0 flex items-start gap-3"
								data-testid="jobs-row"
								data-status={job.status}
							>
								<span class="badge badge-sm {statusColor(job.status)}" data-testid="jobs-row-status">{job.status}</span>
								<div class="flex-1 min-w-0">
									<div class="text-xs flex items-baseline gap-2 flex-wrap">
										<span class="font-mono opacity-50 text-[10px] truncate">{job.id.slice(0, 8)}</span>
										<span class="opacity-80">{summarizeInput(job.input)}</span>
										<!-- The attempt counter is signal, not chrome. -->
										<span class="text-xs">attempt {job.attempts}</span>
										<span class="opacity-40 text-[10px] ml-auto">{fmtTime(job.updatedAt)}</span>
									</div>
									{#if job.status === 'committed' && job.result}
										<div class="text-[11px] opacity-60 mt-0.5" data-testid="jobs-row-result">
											ok in {((job.result.finishedAt ?? 0) - (job.createdAt ?? 0))}ms (attempt {job.result.attempt})
										</div>
									{/if}
									{#if job.status === 'failed' && job.error}
										<div class="text-[11px] text-error mt-0.5" data-testid="jobs-row-error">
											{job.error.message ?? JSON.stringify(job.error)}
										</div>
									{/if}
									{#if rowErrors[job.id]}
										<div class="text-[11px] text-error mt-0.5" data-testid="jobs-row-takeover-error">
											{rowErrors[job.id]}
										</div>
									{/if}
								</div>
								{#if job.status === 'running'}
									<button
										class="btn btn-sm btn-warning pointer-coarse:min-h-11 pointer-coarse:min-w-11"
										onclick={() => handleForceTakeover(job.id)}
										data-testid="jobs-row-takeover"
									>
										Force takeover
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		<aside class="text-xs opacity-50 leading-relaxed space-y-2">
			<p>
				The page subscribes to <code>demos:jobs:list</code> (the row list, capped at 30) and
				<code>demos:jobs:stats</code> (status counts). Both publish via <code>merge: 'set'</code> -
				every event replaces the value, since the canonical state lives in Postgres and the demo
				doesn't try to track per-row crud events from inside the runner's state machine.
			</p>
			<p>
				Force takeover bumps <code>fence_expires_at</code> back into the past; the runner's
				recovery sweep (<code>recoveryInterval: 2000</code>) reclaims the row and rearms with a
				new fence within ~2s. The original handler's heartbeat
				(<code>heartbeatInterval: 1500</code>) sees the fence drift and aborts via
				<code>ctx.signal</code>. With the Redis fence enabled, abort fires on the next heartbeat
				tick instead of waiting for Postgres time math.
			</p>
			<p>
				Retry policy: handler exceptions trigger up to 3 attempts (linear 250ms backoff). The
				<code>fail-once</code> mode throws on attempt 1 and commits on attempt 2;
				<code>fail-always</code> exhausts retries and lands the row at <code>failed</code>.
			</p>
		</aside>
	{/if}
</div>
