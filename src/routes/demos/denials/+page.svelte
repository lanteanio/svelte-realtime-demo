<!--
	/demos/denials - subscribe-denied banner with org switcher.

	You are an employee of either Acme or Globex (set in your identity
	cookie). Two audit-log streams render side-by-side; only your own
	org's stream is allowed. The other returns FORBIDDEN at subscribe
	time - via the wire-level subscribe gate in src/hooks.ws.js, which
	fires for both wire-level subscribe-batch frames and realtime
	stream RPCs.

	The page reads denials from two surfaces:
	- Per-stream `.error` Readable: drives the inline banner on each
	  card so the denied stream renders contextually.
	- Adapter-level `denials` Readable: drives the "Recent denials"
	  list at the bottom. Same reasons, different presentation - pick
	  whichever fits the app's UX.
-->
<script>
	import { onMount } from 'svelte'
	import { auditLog, appendEntry, myOrg } from '$live/demos/denials'
	import { denials as adapterDenials } from 'svelte-adapter-uws/client'

	let me = $state({ org: null, name: null })
	let acmeEntries = $state([])
	let acmeError = $state(null)
	let globexEntries = $state([])
	let globexError = $state(null)
	let recentDenials = $state([])

	let appendDraft = $state('')
	let switching = $state(false)
	let appendError = $state(null)

	function recordDenial(topic, err) {
		if (!err) return
		const entry = { topic, reason: err.code ?? 'ERROR', at: Date.now() }
		recentDenials = [entry, ...recentDenials].slice(0, 8)
	}

	onMount(() => {
		myOrg().then((r) => { me = r })

		const acmeStore = auditLog('acme')
		const offAcme = acmeStore.subscribe((v) => { acmeEntries = v ?? [] })
		const offAcmeErr = acmeStore.error.subscribe((v) => {
			acmeError = v
			recordDenial('audit:acme', v)
		})

		const globexStore = auditLog('globex')
		const offGlobex = globexStore.subscribe((v) => { globexEntries = v ?? [] })
		const offGlobexErr = globexStore.error.subscribe((v) => {
			globexError = v
			recordDenial('audit:globex', v)
		})

		// Adapter-level denials still useful: fires on direct on(topic)
		// subscribes that bypass the stream-RPC path. Aggregating both
		// surfaces here keeps the recent-list accurate regardless of
		// which way the denial came in.
		const offDenials = adapterDenials.subscribe((d) => {
			if (!d) return
			recentDenials = [{ topic: d.topic, reason: d.reason, at: Date.now() }, ...recentDenials].slice(0, 8)
		})

		return () => {
			offAcme(); offAcmeErr(); offGlobex(); offGlobexErr(); offDenials()
		}
	})

	async function switchTo(org) {
		if (switching || org === me.org) return
		switching = true
		try {
			const r = await fetch('/api/demos/set-org', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ org })
			})
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			location.reload()
		} catch (err) {
			switching = false
			appendError = `Switch failed: ${err.message}`
		}
	}

	async function handleAppend() {
		const action = appendDraft.trim()
		if (!action || !me.org) return
		appendError = null
		try {
			await appendEntry(me.org, action)
			appendDraft = ''
		} catch (err) {
			appendError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
		}
	}

	function fmtTs(ts) {
		return new Date(ts).toLocaleTimeString()
	}

	function denialCopy(err) {
		if (!err) return null
		switch (err.code) {
			case 'FORBIDDEN': return "You don't work here. The server denied this subscription with FORBIDDEN."
			case 'UNAUTHENTICATED': return 'Sign in to view this audit log.'
			case 'RATE_LIMITED': return 'Too many subscribe attempts. Slow down.'
			case 'INVALID_TOPIC': return 'That topic is malformed.'
			default: return err.message ?? `Subscribe denied: ${err.code}`
		}
	}
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Subscribe denials with org switcher</h1>
		<p class="text-sm opacity-70 mt-1">
			Two organizations, one identity cookie. Each org's audit log
			lives on its own topic; subscribes from the wrong org return
			<code>FORBIDDEN</code> at the wire layer, before any data
			reaches the client.
		</p>
	</header>

	<div class="card bg-base-200">
		<div class="card-body py-3 flex-row items-center justify-between gap-4">
			<div>
				<div class="text-xs opacity-60">You are</div>
				<div data-testid="my-identity">
					<strong>{me.name ?? '...'}</strong>
					{#if me.org}
						-- <span class="badge badge-primary uppercase" data-testid="my-org">{me.org}</span> employee
					{:else}
						<span class="badge badge-warning">no org</span>
					{/if}
				</div>
			</div>
			<div class="flex gap-2" role="group" aria-label="Organization">
				<!-- A mis-tap costs a full reload: compact on fine pointers,
				     44px where taps land. -->
				<button
					class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					class:btn-primary={me.org === 'acme'}
					onclick={() => switchTo('acme')}
					disabled={switching}
					aria-pressed={me.org === 'acme'}
					data-testid="switch-acme"
				>
					Acme
				</button>
				<button
					class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					class:btn-primary={me.org === 'globex'}
					onclick={() => switchTo('globex')}
					disabled={switching}
					aria-pressed={me.org === 'globex'}
					data-testid="switch-globex"
				>
					Globex
				</button>
			</div>
		</div>
	</div>

	<div class="grid md:grid-cols-2 gap-4">
		{#each [{ slug: 'acme', label: 'Acme', entries: acmeEntries, error: acmeError }, { slug: 'globex', label: 'Globex', entries: globexEntries, error: globexError }] as col (col.slug)}
			<div class="card border border-base-300 min-h-[20rem]" data-testid="card-{col.slug}">
				<div class="card-body py-3">
					<div class="flex justify-between items-baseline">
						<h2 class="card-title text-sm">{col.label} audit log</h2>
						{#if me.org === col.slug}
							<span class="badge badge-success badge-xs">your org</span>
						{/if}
					</div>

					{#if col.error}
						<div class="alert alert-error" data-testid="banner-{col.slug}">
							<div>
								<div class="font-semibold">{col.error.code ?? 'ERROR'}</div>
								<div class="text-xs opacity-80">{denialCopy(col.error)}</div>
							</div>
						</div>
					{:else}
						<ul class="space-y-1 text-xs font-mono mt-2 max-h-72 overflow-y-auto" data-testid="entries-{col.slug}">
							{#each col.entries as entry (entry.id)}
								<li class="flex justify-between gap-3">
									<span class="opacity-60 shrink-0">{fmtTs(entry.ts)}</span>
									<span class="opacity-60 shrink-0">{entry.actor}</span>
									<span class="flex-1">{entry.action}</span>
								</li>
							{:else}
								<li class="opacity-40 text-center py-4">No entries.</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if me.org}
		<form onsubmit={(e) => { e.preventDefault(); handleAppend() }} class="flex gap-2">
			<input
				class="input input-bordered flex-1"
				bind:value={appendDraft}
				placeholder="Append to {me.org} audit log..."
				data-testid="append-input"
			/>
			<button
				type="submit"
				class="btn btn-primary"
				disabled={!appendDraft.trim()}
				data-testid="append-button"
			>
				Append
			</button>
		</form>
		{#if appendError}
			<div class="text-xs text-error" data-testid="append-error">{appendError}</div>
		{/if}
	{/if}

	{#if recentDenials.length > 0}
		<div class="card bg-base-100 border border-base-300">
			<div class="card-body py-3">
				<h2 class="card-title text-sm">Recent denials (adapter <code>denials</code> Readable)</h2>
				<ul class="text-xs font-mono space-y-1" data-testid="recent-denials">
					{#each recentDenials as d, i (i + ':' + d.topic + ':' + d.at)}
						<li class="flex justify-between gap-3">
							<span class="opacity-60 shrink-0">{fmtTs(d.at)}</span>
							<span class="flex-1 truncate">{d.topic}</span>
							<span class="badge badge-error badge-xs">{d.reason}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>denialFor(topic, ws)</code> in
			<code>src/hooks.ws.js</code> matches <code>audit:&#123;org&#125;</code>
			and returns <code>'FORBIDDEN'</code> when
			<code>ws.userData.org</code> doesn't match. The same gate
			fires for both wire-level <code>subscribe-batch</code> frames
			(adapter <code>on(topic)</code>) and realtime stream RPCs
			(via <code>platform.checkSubscribe</code>).
		</p>
		<p>
			Client: per-stream <code>store.error</code> for the inline
			banner; <code>denials</code> from
			<code>svelte-adapter-uws/client</code> for the global recent-list.
		</p>
	</aside>
</div>
