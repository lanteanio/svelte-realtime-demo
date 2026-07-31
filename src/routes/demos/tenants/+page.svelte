<!--
	/demos/tenants: strict per-connection tenant isolation.

	One scratchpad stream, one literal topic. Pick a tenant and the
	next connection is scoped server-side: every topic it touches
	lives under @t/<tenantId>/... and the other tenant's tab literally
	cannot subscribe to it. The server handlers are byte-identical to
	a single-tenant app - only the app-owned Redis key names the
	tenant, because storage layout is the app's business.

	Switching requires a reload: the tenant resolver runs once per
	connection at WebSocket upgrade, never mid-connection.
-->
<script>
	import { onMount } from 'svelte'
	import { pad, addNote, whoami } from '$live/demos/tenants'

	let { data } = $props()

	// Server-trusted tenant, confirmed over the live connection.
	// undefined = whoami still in flight; fall back to the SSR value
	// so the banner renders instantly.
	let wsTenant = $state(undefined)
	let whoamiError = $state(null)
	const activeTenant = $derived(
		wsTenant !== undefined ? wsTenant : (data.identity?.tenant ?? null)
	)
	const literalPadTopic = 'demos:tenants:pad'
	const effectivePadTopic = $derived(
		activeTenant ? `@t/${activeTenant}/${literalPadTopic}` : literalPadTopic
	)

	const notes = $derived($pad ?? [])
	let padError = $state(null)

	let switching = $state(false)
	let switchError = $state(null)
	let noteDraft = $state('')
	let posting = $state(false)
	let postError = $state(null)

	onMount(() => {
		whoami()
			.then((r) => { wsTenant = r.tenantId })
			.catch((err) => { whoamiError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}` })

		const offErr = pad.error.subscribe((v) => { padError = v })
		return () => offErr()
	})

	async function switchTenant(tenant) {
		if (switching || tenant === activeTenant) return
		switching = true
		switchError = null
		try {
			const r = await fetch('/api/demos/set-tenant', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tenant })
			})
			if (!r.ok) throw new Error(`HTTP ${r.status}`)
			// The resolver runs per-connection at upgrade - a reload is
			// required so the next WS handshake picks up the new tenant.
			location.reload()
		} catch (err) {
			switching = false
			switchError = `Switch failed: ${err?.message ?? err}`
		}
	}

	async function handlePost() {
		const text = noteDraft.trim()
		if (!text || posting) return
		posting = true
		postError = null
		try {
			await addNote(text)
			noteDraft = ''
		} catch (err) {
			postError = `${err?.code ?? 'ERROR'}: ${err?.message ?? err}`
		} finally {
			posting = false
		}
	}

	function fmtTs(ts) {
		return new Date(ts).toLocaleTimeString()
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Multi-tenancy: strict per-connection isolation</h1>
		<p class="text-sm opacity-70 mt-1">
			One scratchpad stream on one literal topic. With Acme active,
			everything this connection touches lives under
			<code>@t/acme/...</code> - the Globex tab literally cannot
			subscribe to it, not even by hand-rolled wire frames. The
			handlers are byte-identical to a single-tenant app; the
			framework scopes the topics, the app scopes its own Redis keys
			via <code>ctx.tenantId</code>.
		</p>
	</header>

	<!-- Tenant switcher -->
	<div class="card bg-base-200">
		<div class="card-body py-3 space-y-2">
			<div class="flex flex-wrap items-center justify-between gap-4">
				<div>
					<div class="text-xs opacity-60">Active tenant (server-trusted, from <code>ctx.tenantId</code>)</div>
					<div class="mt-1">
						{#if activeTenant}
							<span class="badge badge-primary uppercase" data-testid="tn-active-tenant">{activeTenant}</span>
						{:else}
							<span class="badge badge-ghost" data-testid="tn-active-tenant">none</span>
						{/if}
						{#if wsTenant === undefined && !whoamiError}
							<span class="text-xs opacity-40 ml-1" data-testid="tn-ws-pending">confirming over WS...</span>
						{/if}
					</div>
				</div>
				<div class="flex gap-2" role="group" aria-label="Tenant scope">
					<!-- A mis-tap reloads into the wrong tenant scope: compact on
					     fine pointers, 44px where taps land. -->
					<button
						class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						class:btn-primary={activeTenant === 'acme'}
						onclick={() => switchTenant('acme')}
						disabled={switching}
						aria-pressed={activeTenant === 'acme'}
						data-testid="tn-set-acme"
					>
						Acme
					</button>
					<button
						class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						class:btn-primary={activeTenant === 'globex'}
						onclick={() => switchTenant('globex')}
						disabled={switching}
						aria-pressed={activeTenant === 'globex'}
						data-testid="tn-set-globex"
					>
						Globex
					</button>
					<button
						class="btn btn-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11"
						class:btn-primary={activeTenant === null}
						onclick={() => switchTenant(null)}
						disabled={switching}
						aria-pressed={activeTenant === null}
						data-testid="tn-clear"
					>
						No tenant
					</button>
				</div>
			</div>
			<p class="text-xs opacity-60">
				Switching reloads the page: the tenant resolver runs once per
				connection at WebSocket upgrade, never mid-connection.
			</p>
			<div class="alert alert-warning py-2 text-xs" data-testid="tn-scope-warning">
				<span>
					While a tenant is active, EVERY demo page on this site is
					isolated to it - presence counts, boards, chat. Clear the
					tenant to return to the shared world.
				</span>
			</div>
			{#if switchError}
				<div class="text-xs text-error" data-testid="tn-switch-error">{switchError}</div>
			{/if}
			{#if whoamiError}
				<div class="text-xs text-error" data-testid="tn-whoami-error">{whoamiError}</div>
			{/if}
		</div>
	</div>

	<!-- Scratchpad -->
	<div class="card bg-base-100 border border-base-300">
		<div class="card-body py-3 space-y-2">
			<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h2 class="card-title text-sm">
					{activeTenant ? `${activeTenant} scratchpad` : 'Public scratchpad'}
					<span class="text-xs opacity-50 font-normal">last 20 notes, live</span>
				</h2>
				<div class="flex min-w-0 max-w-full items-center gap-1 text-xs" aria-label="Effective wire topic">
					<span class="opacity-60 shrink-0">wire</span>
					<code
						class="badge badge-outline badge-sm h-auto max-w-full break-all py-1 font-mono"
						title={effectivePadTopic}
						data-testid="tn-wire-topic"
					>{effectivePadTopic}</code>
				</div>
			</div>

			<form onsubmit={(e) => { e.preventDefault(); handlePost() }} class="flex gap-2">
				<input
					class="input input-bordered input-sm flex-1 pointer-coarse:min-h-11"
					bind:value={noteDraft}
					maxlength="200"
					placeholder="Leave a note for everyone in this scope..."
					disabled={posting}
					data-testid="tn-note-input"
				/>
				<button
					type="submit"
					class="btn btn-sm btn-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11"
					disabled={posting || !noteDraft.trim()}
					data-testid="tn-note-submit"
				>
					{posting ? 'Posting...' : 'Post'}
				</button>
			</form>
			{#if postError}
				<div class="text-xs text-error" data-testid="tn-post-error">{postError}</div>
			{/if}

			{#if padError}
				<div class="alert alert-error py-2 text-xs" data-testid="tn-pad-error">
					<span>{padError.code ?? 'ERROR'}: {padError.message ?? 'Subscribe failed'}</span>
				</div>
			{:else}
				<ul class="space-y-1 text-xs font-mono max-h-80 overflow-y-auto" data-testid="tn-notes-list">
					{#each notes as note (note.id)}
						<li class="flex gap-3" data-testid="tn-note-row">
							<span class="opacity-50 shrink-0">{fmtTs(note.ts)}</span>
							<span class="opacity-50 shrink-0">{note.author}</span>
							<span class="flex-1">{note.text}</span>
						</li>
					{:else}
						<li class="opacity-40 text-center py-4" data-testid="tn-notes-empty">No notes in this scope yet.</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>realtime(&#123; tenant: (user) =&gt; user?.tenant ?? null &#125;)</code>
			in <code>src/hooks.ws.js</code> derives a server-trusted
			<code>ctx.tenantId</code> per connection (never read off the
			wire). The stream and every <code>ctx.publish</code> in
			<code>tenants.js</code> use the literal topic
			<code>demos:tenants:pad</code>; under an active tenant the
			framework auto-prefixes it to
			<code>@t/&lt;tenantId&gt;/demos:tenants:pad</code>. App-owned
			storage is not auto-scoped, so the Redis key is scoped manually
			with <code>ctx.tenantId</code>. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/tenants.js">tenants.js</a>.
		</p>
		<p>
			Client: <code>$pad</code> is a normal stream store and
			<code>addNote</code> a normal RPC - the page has no tenant
			awareness beyond the switcher; isolation is entirely
			server-side.
		</p>
	</aside>
</div>
