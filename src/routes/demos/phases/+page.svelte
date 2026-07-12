<!--
	/demos/phases: attach/detach lifecycle + the atomic publish batch.

	Card 1 drives the per-subscription attach machine explicitly:
	attach() holds the stream open with no UI subscriber (and
	reattaches across outages); detach() means "done" and tears the
	subscription down immediately. The phase badge renders the
	read-only `phase` store live.

	Card 2 proves ctx.batch(fn)'s drop-on-throw contract across an
	await boundary: "Publish pair" lands two entries; "fail midway"
	lands NEITHER, even though the first publish was issued before
	the throw.
-->
<script>
	import { onMount } from 'svelte'
	import { feed, postTwo } from '$live/demos/phases'

	let { data } = $props()
	const me = $derived(data.identity)

	// The read-only attach-machine projection; safe to subscribe to
	// without touching the stream subscription itself.
	const phase = feed.phase

	let entries = $state(/** @type {Array<{ id: string, label: string, half: number, at: number }>} */ ([]))
	let attachError = $state('')
	let batchError = $state('')
	let lastPair = $state(/** @type {{ first: string, second: string } | null} */ (null))
	let publishing = $state(false)

	// The UI subscriber is held ONLY while attached, because a live UI
	// subscriber would keep the stream attached on its own behalf and
	// make the Detach button a no-op. attach()/detach() manage the
	// subscription; this manages the rendered values.
	/** @type {(() => void) | null} */
	let offValues = null

	function subscribeValues() {
		if (offValues) return
		offValues = feed.subscribe((v) => {
			entries = Array.isArray(v) ? v.slice() : []
		})
	}

	function unsubscribeValues() {
		if (offValues) {
			offValues()
			offValues = null
		}
	}

	async function handleAttach() {
		attachError = ''
		try {
			await feed.attach()
			subscribeValues()
		} catch (err) {
			attachError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		}
	}

	function handleDetach() {
		// Order matters: drop the UI subscriber FIRST, otherwise the
		// stream stays attached on its behalf after detach().
		unsubscribeValues()
		feed.detach()
		entries = []
	}

	onMount(() => {
		handleAttach()
		return () => {
			// detach() rather than a bare unsubscribe: the attach() retain
			// would otherwise hold the subscription open after navigation.
			unsubscribeValues()
			feed.detach()
		}
	})

	async function handlePublish(failMidway) {
		if (publishing) return
		publishing = true
		batchError = ''
		try {
			const result = await postTwo(failMidway)
			lastPair = { first: result?.first?.id ?? '', second: result?.second?.id ?? '' }
		} catch (err) {
			batchError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			publishing = false
		}
	}

	function phaseClass(p) {
		switch (p) {
			case 'attached': return 'badge-success'
			case 'attaching': return 'badge-info'
			case 'detached': return 'badge-ghost'
			case 'failed': return 'badge-error'
			default: return 'badge-neutral'
		}
	}

	function fmtTs(ts) {
		return new Date(ts).toLocaleTimeString()
	}
</script>

<div class="max-w-3xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Phases: attach lifecycle + atomic publish batch</h1>
		<p class="text-sm opacity-70 mt-1">
			Every stream store exposes its attach machine as a read-only
			<code>phase</code> store
			(<code>initialized -&gt; attaching -&gt; attached -&gt; detached | failed</code>)
			plus explicit <code>attach()</code> / <code>detach()</code>
			controls. And on the server, <code>ctx.batch(fn)</code> turns
			publishes into an all-or-nothing batch: a throw after an
			<code>await</code> retracts publishes issued <em>before</em> it.
		</p>
		{#if me}
			<p class="text-xs opacity-50 mt-1">
				Reading as
				<span class="inline-block w-2 h-2 rounded-full align-middle" style:background={me.color}></span>
				<strong>{me.name}</strong>
				<span class="font-mono">({me.id.slice(0, 8)})</span>
			</p>
		{/if}
	</header>

	<!-- Card 1: lifecycle -->
	<section class="card bg-base-200" data-testid="ph-lifecycle-card">
		<div class="card-body py-3 space-y-2">
			<div class="flex items-center gap-3 flex-wrap">
				<h2 class="card-title text-sm">Subscription lifecycle</h2>
				<span class="badge {phaseClass($phase)}" data-testid="ph-phase">{$phase}</span>
				<div class="ml-auto flex gap-2">
					<button class="btn btn-sm btn-primary" onclick={handleAttach} disabled={$phase === 'attached' || $phase === 'attaching'} data-testid="ph-attach">
						Attach
					</button>
					<button class="btn btn-sm btn-ghost" onclick={handleDetach} disabled={$phase === 'detached'} data-testid="ph-detach">
						Detach
					</button>
				</div>
			</div>

			{#if $phase === 'attached'}
				<ul class="text-xs font-mono space-y-1 min-h-[6rem]" data-testid="ph-feed">
					{#each entries as e (e.id)}
						<li class="flex items-center gap-2" data-testid="ph-feed-row">
							<span class="opacity-60 w-20">{fmtTs(e.at)}</span>
							<span class="badge badge-ghost badge-xs">{e.half === 1 ? 'first' : 'second'}</span>
							<span class="flex-1 truncate">{e.label}</span>
							<span class="opacity-40">{e.id.slice(0, 8)}</span>
						</li>
					{:else}
						<li class="opacity-40 text-center py-4" data-testid="ph-feed-empty">Feed is empty. Publish a pair below.</li>
					{/each}
				</ul>
				<p class="text-xs opacity-60">
					<span data-testid="ph-feed-count">{entries.length}</span> entries visible.
				</p>
			{:else}
				<p class="text-xs opacity-40 min-h-[6rem] flex items-center justify-center" data-testid="ph-feed-hidden">
					Feed hidden - the subscription is {$phase}. Attach to render it.
				</p>
			{/if}

			{#if attachError}
				<p class="text-xs text-error" data-testid="ph-attach-error">{attachError}</p>
			{/if}
			<p class="text-xs opacity-60">
				<code>attach()</code> holds an internal retain: the stream
				stays subscribed with <em>no</em> UI subscriber and reattaches
				itself across outages (watch the badge cycle
				<code>attaching -&gt; attached</code> after a reconnect).
				<code>detach()</code> is "done" - it releases the retain and
				tears the subscription down immediately, skipping the
				resume-grace window a normal component unmount gets.
			</p>
		</div>
	</section>

	<!-- Card 2: atomic batch -->
	<section class="card bg-base-100 border border-base-300" data-testid="ph-batch-card">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Atomic publish batch</h2>
			<div class="flex flex-wrap gap-2 items-center">
				<button class="btn btn-sm btn-primary" onclick={() => handlePublish(false)} disabled={publishing} data-testid="ph-publish-pair">
					Publish pair
				</button>
				<button class="btn btn-sm btn-warning" onclick={() => handlePublish(true)} disabled={publishing} data-testid="ph-publish-fail">
					Publish pair, fail midway
				</button>
				{#if lastPair}
					<span class="text-xs opacity-70" data-testid="ph-last-pair">
						published <span class="font-mono">{lastPair.first.slice(0, 8)}</span>
						+ <span class="font-mono">{lastPair.second.slice(0, 8)}</span>
					</span>
				{/if}
			</div>
			{#if batchError}
				<p class="text-xs text-error" data-testid="ph-batch-error">{batchError}</p>
			{/if}
			<p class="text-xs opacity-60">
				Both buttons run the same handler:
				<code>ctx.batch(async () =&gt; &#123; publish first; await;
				maybe throw; publish second &#125;)</code>. The failing
				variant throws BETWEEN the two publishes, after a real await
				boundary - and neither entry appears, because the collector
				buffers publishes across awaits precisely so a later throw
				can retract them. Bare <code>ctx.publish</code> would already
				have flushed the first one at the await.
			</p>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>feed = live.stream('demos:phases:feed', loader,
			&#123; merge: 'crud', key: 'id' &#125;)</code> and
			<code>postTwo = live(async (ctx, failMidway) =&gt;
			ctx.batch(async () =&gt; ...))</code>. The batch retracts
			PUBLISHES only - storage is the app's own transaction problem -
			so the handler orders its work validation first, Redis writes
			after the last throw site, everything flushing together. See
			<a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/phases.js">phases.js</a>.
		</p>
		<p>
			Client: <code>feed.attach()</code> resolves on the server's
			subscription confirmation (the loader response - no extra wire
			frame), which also enables the "don't publish until fully
			attached" pattern: <code>await feed.attach()</code> before the
			RPC whose broadcast you must not miss. <code>feed.phase</code>
			is a plain readable store; subscribing to it never touches the
			stream subscription itself.
		</p>
	</aside>
</div>
