<!--
	/demos/schema-evolution: live.stream version + migrate hooks via
	subscribeAt.

	One stream registered at `version: 2` with `migrate: { 1: v1ToV2 }`.
	The left panel subscribes normally; the wire envelope carries no
	`schemaVersion`, so the loader's v2 payload comes back unchanged.
	The right panel uses `subscribeAt(counter, { schemaVersion: 1 })`
	from `svelte-realtime/test-client`; the wire envelope claims
	`schemaVersion: 1`, and the server's migrate chain runs end-to-end
	on the loader output, stamping `provenance: 'migrate[1]'`.

	After increment, the affected row's `provenance` flips back to
	`loader` in the right panel (the live publish is a raw v2 event,
	merging into the migrated base for that key). Untouched rows keep
	their `migrate[1]` badge until they too receive a live publish.
	This matches the production reconnect semantics: migrate fires
	once on subscribe, then live updates flow through at the current
	version unchanged.
-->
<script>
	import { onMount, onDestroy } from 'svelte'
	import {
		counter,
		myCounterState,
		incrementCounter,
		resetCounters
	} from '$live/demos/schema-evolution'
	import { subscribeAt } from 'svelte-realtime/test-client'

	let { data } = $props()
	const me = $derived(data.identity)

	// `subscribeAt` walks the test-client wire path and reads
	// `__streamPath` off the stream object. The SSR stub for `$live/`
	// streams is a plain hydrate-readable without that metadata, so the
	// call must run client-only. Set up in onMount, tear down on
	// destroy. Bridge into a plain $state list for templating.
	/** @type {any} */
	let counterAsV1Store = $state(null)
	let v1List = $state([])
	let v1Off = null

	onMount(() => {
		counterAsV1Store = subscribeAt(counter, { schemaVersion: 1 })
		v1Off = counterAsV1Store.subscribe((v) => {
			v1List = Array.isArray(v) ? v.slice() : []
		})
	})
	onDestroy(() => {
		v1Off?.()
	})

	let state = $state({
		serverVersion: 2,
		seedIds: ['alpha', 'beta', 'gamma'],
		migrateSource: ''
	})

	onMount(async () => {
		try {
			state = await myCounterState()
		} catch {}
	})

	let busy = $state(false)
	let lastError = $state('')

	async function bump(id) {
		if (busy) return
		busy = true
		lastError = ''
		try {
			await incrementCounter(id)
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			busy = false
		}
	}

	async function reset() {
		if (busy) return
		busy = true
		lastError = ''
		try {
			await resetCounters()
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			busy = false
		}
	}

	function provenanceBadge(prov) {
		return prov === 'migrate[1]' ? 'badge-warning' : 'badge-info'
	}
</script>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Schema evolution: subscribe-time migrate hooks</h1>
		<p class="text-sm opacity-70 mt-1">
			One stream registered at <code>version: 2</code> with
			<code>migrate: &#123; 1: v1ToV2 &#125;</code>. Left panel subscribes
			normally (no <code>schemaVersion</code> on the wire, loader output
			passes through). Right panel uses
			<code>subscribeAt(counter, &#123; schemaVersion: 1 &#125;)</code>
			from <code>svelte-realtime/test-client</code> - the server's
			<code>migrate[1]</code> runs end-to-end on the initial subscribe
			response. Increment a counter and watch the right panel's row
			flip its provenance badge back to <code>loader</code>: the live
			publish is a raw v2 event, merging into the migrated base for
			that key.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Watching as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
				<span class="ml-2 badge badge-sm badge-outline">server version: {state.serverVersion}</span>
			</p>
		{/if}
	</header>

	<!-- Two panels side by side -->
	<section class="grid sm:grid-cols-2 gap-4" data-testid="panels">
		<div class="card bg-base-100 border border-base-300" data-testid="v2-panel">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Live (v2): subscribed normally</h2>
				<p class="text-xs opacity-60">no <code>schemaVersion</code> on the wire; migrate chain skipped.</p>
				<ul class="space-y-2" data-testid="v2-list">
					{#each $counter ?? [] as c (c.id)}
						<li class="flex items-center gap-2" data-testid="v2-card">
							<span class="inline-block w-3 h-3 rounded shrink-0" style:background={c.color}></span>
							<span class="text-sm font-medium" data-testid="v2-label">{c.label}</span>
							<span class="badge badge-xs {provenanceBadge(c.provenance)}" data-testid="v2-provenance">{c.provenance}</span>
							<span class="ml-auto font-mono" data-testid="v2-value-{c.id}">{c.value}</span>
						</li>
					{:else}
						<li class="opacity-40 text-xs" data-testid="v2-empty">loading...</li>
					{/each}
				</ul>
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300" data-testid="v1mig-panel">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">subscribeAt &#123; schemaVersion: 1 &#125;: migrate chain ran</h2>
				<p class="text-xs opacity-60">wire envelope claims v1; server runs <code>migrate[1]</code> on the loader output.</p>
				<ul class="space-y-2" data-testid="v1mig-list">
					{#each v1List as c (c.id)}
						<li class="flex items-center gap-2" data-testid="v1mig-card">
							<span class="inline-block w-3 h-3 rounded shrink-0" style:background={c.color}></span>
							<span class="text-sm font-medium" data-testid="v1mig-label">{c.label}</span>
							<span class="badge badge-xs {provenanceBadge(c.provenance)}" data-testid="v1mig-provenance-{c.id}">{c.provenance}</span>
							<span class="ml-auto font-mono" data-testid="v1mig-value-{c.id}">{c.value}</span>
						</li>
					{:else}
						<li class="opacity-40 text-xs" data-testid="v1mig-empty">loading...</li>
					{/each}
				</ul>
			</div>
		</div>
	</section>

	<!-- Increment controls -->
	<section class="card bg-base-200" data-testid="controls-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Bump a counter</h2>
			<div class="flex flex-wrap gap-2 items-center">
				{#each state.seedIds as id (id)}
					<button
						class="btn btn-sm btn-primary"
						onclick={() => bump(id)}
						disabled={busy}
						data-testid={'bump-' + id}
					>
						Increment {id}
					</button>
				{/each}
				<button
					class="btn btn-sm btn-ghost ml-auto"
					onclick={reset}
					disabled={busy}
					data-testid="reset"
				>
					Reset all
				</button>
			</div>
			{#if lastError}
				<p class="text-xs text-error" data-testid="error">{lastError}</p>
			{/if}
		</div>
	</section>

	<!-- Migrate config snippet -->
	<section class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Stream registration</h2>
			<pre class="text-xs font-mono bg-base-200 p-3 rounded overflow-x-auto whitespace-pre" data-testid="migrate-source">{state.migrateSource}</pre>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: every subscribe-batch wire frame carries an optional
			<code>schemaVersion</code>. When set and less than the stream's
			<code>version</code>, <code>_executeStreamRpc</code> runs
			<code>_migrateData(loaderOutput, fromVersion, toVersion, migrateFns)</code>
			on the response payload. The chain composes forward through
			every <code>migrate[N]</code> in the registered map until it
			reaches the current version.
		</p>
		<p>
			Client: <code>_schemaVersion</code> is closure-local in each
			stream subscription, set only by server responses. Production
			code can never present a stale <code>schemaVersion</code> from
			a fresh tab. The <code>subscribeAt</code> helper from
			<code>svelte-realtime/test-client</code> takes a stream and an
			explicit <code>schemaVersion</code>, walks the same wire path
			as a real reconnecting stale client, and returns a parallel
			Svelte store.
		</p>
		<p>
			<strong>Production code never imports <code>/test-client</code>.</strong>
			The path is a loud signal that this is a debug / demo
			affordance.
		</p>
	</aside>
</div>
