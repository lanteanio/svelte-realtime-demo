<!--
	/demos/alarms - durable one-shot timers.

	Schedule an alarm (+10s / +30s / +2min / custom seconds), watch the
	pending card count down, and see the fired record land in the log
	with scheduled-vs-actual timing. The wow: schedule +2min, kill the
	worker (or redeploy) - the alarm still fires exactly once, and the
	record shows recovered: true when the restart ate the precise timer
	and the recovery poll fired it instead.
-->
<script>
	import { onMount } from 'svelte'
	import { timers, schedule, cancel, pendingAlarm } from '$live/demos/alarms'

	let { data } = $props()
	const me = $derived(data.identity)

	let entries = $state(/** @type {Array<{ id: string, at: number, firedAt: number, lateMs: number, recovered: boolean }>} */ ([]))

	$effect(() => {
		const off = timers.subscribe((v) => {
			entries = Array.isArray(v) ? v.slice().sort((a, b) => b.firedAt - a.firedAt) : []
		})
		return () => off()
	})

	// Pending alarm: `at` is server epoch-ms; `skewMs` corrects the local
	// clock against the server clock returned by the same RPC, so the
	// countdown is honest even when the browser clock drifts.
	let pendingAt = $state(/** @type {number | null} */ (null))
	let skewMs = $state(0)
	let nowTick = $state(Date.now())
	let lastError = $state('')
	let busy = $state(false)

	const remainingMs = $derived(pendingAt === null ? null : pendingAt - (nowTick + skewMs))

	async function refreshPending() {
		try {
			const p = await pendingAlarm()
			pendingAt = p?.at ?? null
			skewMs = (p?.now ?? Date.now()) - Date.now()
		} catch (err) {
			lastError = err?.message ?? String(err)
		}
	}

	onMount(() => {
		refreshPending()
		const timer = setInterval(() => {
			nowTick = Date.now()
			// The fired record normally clears the card via the stream
			// effect below; this catches a fire we somehow missed.
			if (pendingAt !== null && pendingAt - (nowTick + skewMs) < -2000) refreshPending()
		}, 250)
		return () => clearInterval(timer)
	})

	// A new fired record means the pending alarm was consumed.
	$effect(() => {
		void entries
		refreshPending()
	})

	async function handleSchedule(seconds) {
		if (busy) return
		busy = true
		lastError = ''
		try {
			const r = await schedule(seconds)
			pendingAt = r?.at ?? pendingAt
			await refreshPending()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busy = false
		}
	}

	let customSeconds = $state(10)

	async function handleCancel() {
		if (busy) return
		busy = true
		lastError = ''
		try {
			await cancel()
			await refreshPending()
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			busy = false
		}
	}

	function fmtTime(ms) {
		return new Date(ms).toLocaleTimeString()
	}

	function fmtCountdown(ms) {
		const s = Math.max(0, Math.ceil(ms / 1000))
		const m = Math.floor(s / 60)
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Durable alarms: one-shot timers that survive restarts</h1>
		<p class="text-sm opacity-70 mt-1">
			One shared room, one pending alarm. <code>ctx.setAlarm(at)</code> arms it;
			<code>onAlarm</code> runs at the deadline with a fresh server ctx even if every
			tab is closed. The wow: schedule <strong>+2min</strong>, kill the worker (or
			redeploy) - the alarm still fires <strong>exactly once</strong> cluster-wide,
			and the fired record shows <code>recovered: true</code> when the restart ate
			the precise timer and the leader's recovery poll fired it instead.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Scheduling as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
			</p>
		{/if}
	</header>

	<!-- Schedule controls -->
	<section class="card bg-base-200" data-testid="al-schedule-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Schedule (one pending alarm per room - scheduling replaces it)</h2>
			<div class="flex flex-wrap gap-2 items-end">
				<button class="btn btn-sm btn-primary" onclick={() => handleSchedule(10)} disabled={busy} data-testid="al-schedule-10">+10s</button>
				<button class="btn btn-sm btn-primary" onclick={() => handleSchedule(30)} disabled={busy} data-testid="al-schedule-30">+30s</button>
				<button class="btn btn-sm btn-primary" onclick={() => handleSchedule(120)} disabled={busy} data-testid="al-schedule-120">+2min</button>
				<form onsubmit={(e) => { e.preventDefault(); handleSchedule(Number(customSeconds)) }} class="flex gap-2 items-end">
					<label class="form-control w-28">
						<span class="label-text text-xs">Custom (2-600s)</span>
						<input
							type="number"
							class="input input-bordered input-sm"
							min="2" max="600" step="1"
							bind:value={customSeconds}
							disabled={busy}
							data-testid="al-custom-seconds"
						/>
					</label>
					<button type="submit" class="btn btn-sm" disabled={busy} data-testid="al-schedule-custom">Schedule</button>
				</form>
				<button class="btn btn-sm btn-ghost" onclick={handleCancel} disabled={busy} data-testid="al-cancel">Cancel pending</button>
			</div>
			{#if lastError}
				<p class="text-xs text-error" data-testid="al-error">{lastError}</p>
			{/if}
		</div>
	</section>

	<!-- Pending alarm -->
	<section class="card bg-base-100 border border-base-300" data-testid="al-pending">
		<div class="card-body py-3 space-y-1">
			<h2 class="card-title text-sm">Pending alarm</h2>
			{#if pendingAt !== null}
				<p class="text-sm" data-testid="al-pending-at">
					Fires at <span class="font-mono">{fmtTime(pendingAt)}</span>
					<span class="badge badge-sm badge-primary ml-2 font-mono tabular-nums" data-testid="al-pending-countdown">
						{remainingMs !== null ? fmtCountdown(remainingMs) : ''}
					</span>
				</p>
				<p class="text-xs opacity-50">
					Survives worker restarts: the durable row is in the Redis alarm store,
					not in this process's memory.
				</p>
			{:else}
				<p class="opacity-40 text-sm" data-testid="al-pending-empty">No alarm pending.</p>
			{/if}
		</div>
	</section>

	<!-- Fired log -->
	<section class="card bg-base-100 border border-base-300" data-testid="al-log">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Fired alarms (<span data-testid="al-log-count">{entries.length}</span>, newest first)</h2>
			{#if entries.length === 0}
				<p class="opacity-40 text-sm" data-testid="al-log-empty">Nothing has fired yet. Schedule one above.</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono" data-testid="al-log-rows">
					{#each entries as r (r.id)}
						<li class="flex items-center gap-2 flex-wrap" data-testid="al-log-row" data-at={r.at}>
							<span class="opacity-50">scheduled {fmtTime(r.at)}</span>
							<span class="opacity-50">fired {fmtTime(r.firedAt)}</span>
							<span class="badge badge-xs badge-ghost" data-testid="al-log-late">+{r.lateMs}ms late</span>
							{#if r.recovered}
								<span class="badge badge-xs badge-warning" data-testid="al-log-recovered">recovered</span>
							{:else}
								<span class="badge badge-xs badge-success">precise timer</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>timers = live.stream(topic, loader, &#123; alarm: &#123; onAlarm &#125;, invalidateOn &#125;)</code>.
			<code>ctx.setAlarm</code> is bound on the stream's ctx, so the loader is the room's
			single alarm writer: schedule / cancel RPCs record intent in Redis and publish a
			nudge on a control topic; <code>invalidateOn</code> re-runs the loader, which syncs
			the framework alarm to the intent.
		</p>
		<p>
			Cluster single-fire is an atomic store-delete claim: the owning worker's precise
			in-memory timer and the leader's recovery poll can never both fire the same alarm
			(wired app-wide via <code>configureAlarm(&#123; store, leader &#125;)</code>).
			<code>ctx.alarm</code> inside <code>onAlarm</code> carries
			<code>&#123; at, firedAt, lateMs, recovered &#125;</code>. No <code>alarm.misfireMs</code>
			is set here - fire-when-late is right for reminders; an auction close would declare a
			threshold so stale fires are skipped instead of run.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/alarms.js">alarms.js</a>.
		</p>
	</aside>
</div>
