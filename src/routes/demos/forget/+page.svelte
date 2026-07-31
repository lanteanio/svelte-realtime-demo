<!--
	/demos/forget - right to erasure.

	Three stacked steps: leave traces (app log + idempotency cache, on
	top of the presence + push registrations every visitor already
	has), audit the app-side count, then Forget me. The forget result's
	per-surface removal counts render as the erasure audit table; a
	re-run of the audit shows zero.
-->
<script>
	import { leaveTraces, saveDraft, auditTraces, forgetMe } from '$live/demos/forget'
	import { confirmDestructive } from '$lib/confirm-destructive'

	let { data } = $props()
	const me = $derived(data.identity)

	let traces = $state(/** @type {{ added: number, total: number, draftSavedAt: number | null } | null} */ (null))
	let audit = $state(/** @type {{ appLog: number } | null} */ (null))
	let forgetResult = $state(/** @type {{ ok: boolean, at: number, rowsAffected: number, surfaces: Record<string, number> } | null} */ (null))
	let lastError = $state('')
	let busyLeave = $state(false)
	let busyAudit = $state(false)
	let busyForget = $state(false)

	async function handleLeaveTraces() {
		if (busyLeave) return
		busyLeave = true
		lastError = ''
		try {
			const [log, draft] = await Promise.all([leaveTraces(), saveDraft()])
			traces = {
				added: log?.added ?? 0,
				total: log?.total ?? 0,
				draftSavedAt: draft?.savedAt ?? null
			}
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busyLeave = false
		}
	}

	async function handleAudit() {
		if (busyAudit) return
		busyAudit = true
		lastError = ''
		try {
			audit = await auditTraces()
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			busyAudit = false
		}
	}

	async function handleForget() {
		if (busyForget) return
		if (!confirmDestructive('Permanently erase your data from every shared surface?')) return
		busyForget = true
		lastError = ''
		try {
			forgetResult = await forgetMe()
			traces = null
			// Re-run the app-side audit so the zero is visible immediately.
			await handleAudit()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busyForget = false
		}
	}

	const surfaceRows = $derived(forgetResult ? Object.entries(forgetResult.surfaces) : [])
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Right to erasure: <code>live.forget</code></h1>
		<p class="text-sm opacity-70 mt-1">
			One server call purges every trace of a user across the framework - push
			registry and sessions, presence rosters, rate-limit buckets, idempotency
			cached results, dead-letter entries, aggregate k-anonymity cohorts - and
			resolves only after the durable store confirms. The result is a per-surface
			audit: <code>&#123; ok, at, rowsAffected, surfaces &#125;</code>. This demo
			erases <strong>you</strong> (the server uses <code>ctx.user.id</code>, never
			a wire-supplied id).
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				You are
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
				- the identity that gets erased below.
			</p>
		{/if}
	</header>

	<!-- Step 1: leave traces -->
	<section class="card bg-base-200" data-testid="fg-traces-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">1. Leave traces</h2>
			<p class="text-xs opacity-60">
				Writes three entries to an app-owned Redis log keyed by your user id and
				caches a cluster-shared idempotent RPC result keyed by you. Your presence entry and
				push registration already exist just from having this tab open.
			</p>
			<div>
				<!-- Compact on fine pointers, 44px floor where taps land. -->
				<button class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleLeaveTraces} disabled={busyLeave} data-testid="fg-leave-traces">
					{busyLeave ? 'Writing...' : 'Leave traces'}
				</button>
			</div>
			{#if traces}
				<ul
					class="text-xs font-mono space-y-1"
					data-testid="fg-traces-result"
					data-state={`${traces.total}:${traces.draftSavedAt ?? ''}`}
				>
					<li data-testid="fg-traces-applog">app log: +{traces.added} entries ({traces.total} total for you)</li>
					<li data-testid="fg-traces-draft">idempotency cache: draft result cached{traces.draftSavedAt ? ` at ${new Date(traces.draftSavedAt).toLocaleTimeString()}` : ''}</li>
					<li class="opacity-60">presence roster: live entry (from this connection)</li>
					<li class="opacity-60">push registry: live registration (from the layout)</li>
				</ul>
			{/if}
		</div>
	</section>

	<!-- Step 2: audit -->
	<section class="card bg-base-100 border border-base-300" data-testid="fg-audit-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">2. Audit (app-side)</h2>
			<p class="text-xs opacity-60">
				The app can only count its own storage. Framework-internal surfaces are
				not enumerable from app code - the authoritative audit is the surfaces
				map <code>live.forget</code> returns in step 3.
			</p>
			<div class="flex items-center gap-3">
				<button class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleAudit} disabled={busyAudit} data-testid="fg-audit">
					{busyAudit ? 'Counting...' : 'Audit my traces'}
				</button>
				{#if audit}
					<span class="text-sm font-mono">
						app log entries: <strong data-testid="fg-audit-applog">{audit.appLog}</strong>
					</span>
				{/if}
			</div>
		</div>
	</section>

	<!-- Step 3: forget -->
	<section class="card bg-base-100 border border-base-300" data-testid="fg-forget-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">3. Forget me</h2>
			<div>
				<button class="btn btn-sm btn-outline btn-error pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={handleForget} disabled={busyForget} data-testid="fg-forget">
					{busyForget ? 'Erasing...' : 'Forget me'}
				</button>
			</div>
			{#if forgetResult}
				<div class="space-y-2" data-testid="fg-forget-result" data-at={forgetResult.at}>
					<p class="text-sm font-mono">
						ok: <strong data-testid="fg-forget-ok">{String(forgetResult.ok)}</strong>,
						rows affected: <strong data-testid="fg-forget-rows">{forgetResult.rowsAffected}</strong>
					</p>
					<table class="table table-xs" data-testid="fg-surfaces-table">
						<thead>
							<tr><th>surface</th><th class="text-right">rows removed</th></tr>
						</thead>
						<tbody>
							{#each surfaceRows as [name, count] (name)}
								<tr data-testid="fg-surface-row">
									<td class="font-mono" data-testid="fg-surface-name">{name}</td>
									<td class="font-mono text-right" data-testid="fg-surface-count">{count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<p class="text-xs opacity-60">
						Presence, push sessions, rate-limit buckets, idempotency results, and
						dead-letter entries were purged cluster-wide, and the promise resolved
						only after the durable store confirmed. <code>appDemoLog</code> is the
						app-owned half - the framework cannot know about your own Redis keys.
						You stay connected; new traces accrue as you keep using the app.
					</p>
				</div>
			{/if}
			{#if lastError}
				<p class="text-xs text-error" data-testid="fg-error">{lastError}</p>
			{/if}
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>const res = await live.forget(ctx.user.id, &#123; tenantId, onForget &#125;)</code>
			inside a plain <code>live()</code> RPC. <code>live.forget</code> is a server action
			(not reachable from the wire), so the app owns the authorization at the call site -
			here the caller may only erase themselves; an admin path erasing others would add
			its own gate.
		</p>
		<p>
			The <code>onForget</code> audit hook receives a <strong>hashed</strong> userId, so the
			audit log stays PII-free. The result is constant-shape: <code>ok</code> is always
			<code>true</code> on completion, so re-exposing it cannot become a user-existence
			oracle as long as the row counts are mapped away. Wired app-wide via
			<code>configureForget(&#123; store: createForgetStore(...), platform &#125;)</code>.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/forget.js">forget.js</a>.
		</p>
	</aside>
</div>
