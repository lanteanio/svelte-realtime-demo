<!--
	/demos/pagination: cursor-based load-more on a live stream.

	The server's loader returns `{ data, hasMore, cursor }`. The
	framework picks up the paginated shape, propagates `hasMore` to
	the store, and stamps the cursor on every `loadMore()` call's
	subscribe envelope so the loader can reach the next slice. New
	entries appended via `appendLogEntry` publish 'created' on the
	same topic and land at the bottom of the list.

	One headline primitive: cursor-based pagination via the loader's
	return shape plus the client store's `loadMore()` method.
-->
<script>
	import { onDestroy, onMount } from 'svelte'
	import {
		myPaginationState,
		appendLogEntry,
		logFeed
	} from '$live/demos/pagination'

	let { data } = $props()
	const me = $derived(data.identity)

	let state = $state({ totalAtBoot: 200, pageSize: 25, severities: ['info', 'warn', 'error'] })

	onMount(async () => {
		try { state = await myPaginationState() } catch {}
	})

	let entries = $state(/** @type {Array<{ id: string, ts: number, severity: string, message: string, seq: number }>} */ ([]))

	$effect(() => {
		const off = logFeed.subscribe((v) => {
			entries = Array.isArray(v) ? v.slice() : []
		})
		return () => off()
	})

	// Track hasMore in component state. Returned by `loadMore()`; also
	// readable via `logFeed.hasMore`. We reflect it into a $state so
	// Svelte rerenders the button after each load.
	let hasMore = $state(true)
	let loading = $state(false)
	let lastError = $state('')

	async function handleLoadMore() {
		if (loading) return
		loading = true
		lastError = ''
		try {
			hasMore = await logFeed.loadMore()
		} catch (err) {
			lastError = err?.code ? `${err.code}: ${err.message ?? ''}` : (err?.message ?? String(err))
		} finally {
			loading = false
		}
	}

	let appendSeverity = $state('info')
	let appendMessage = $state('manual entry')
	let appending = $state(false)
	let pendingReveal = $state(/** @type {{ id: string, seq: number, message: string } | null} */ (null))
	let highlightedId = $state(/** @type {string | null} */ (null))
	let appendNotice = $state('')
	let feedbackTimer = null

	onDestroy(() => {
		if (feedbackTimer) clearTimeout(feedbackTimer)
	})

	// The publish can land just before or just after the RPC response. Track
	// both the returned id and the reactive list, then reveal only when the
	// exact row is mounted. Remote appends do not steal another viewer's scroll.
	$effect(() => {
		const target = pendingReveal
		if (!target || !entries.some((entry) => entry.id === target.id)) return
		pendingReveal = null
		highlightedId = target.id
		appendNotice = `Appended #${target.seq}: ${target.message}`
		requestAnimationFrame(() => {
			const row = document.querySelector(`[data-entry-id="${target.id}"]`)
			// 'nearest', not 'center': 'center' scrolls even when the row is
			// already fully visible, so every append would jerk the page under a
			// reader who could already see the row. With 'nearest' the
			// scroll-margin-block below is also no longer inert.
			row?.scrollIntoView({
				behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
				block: 'nearest'
			})
		})
		if (feedbackTimer) clearTimeout(feedbackTimer)
		feedbackTimer = setTimeout(() => {
			if (highlightedId === target.id) highlightedId = null
			appendNotice = ''
		}, 2400)
	})

	async function handleAppend() {
		if (appending) return
		appending = true
		try {
			const message = appendMessage.trim() || 'manual entry'
			const appended = await appendLogEntry({ severity: appendSeverity, message })
			pendingReveal = { id: appended.id, seq: appended.seq, message: appended.message }
		} catch (err) {
			lastError = err?.message ?? String(err)
		} finally {
			appending = false
		}
	}

	function severityClass(s) {
		switch (s) {
			case 'error': return 'badge-error'
			case 'warn': return 'badge-warning'
			default: return 'badge-info'
		}
	}

	function timeOf(ts) {
		const d = new Date(ts)
		return d.toLocaleTimeString()
	}
</script>

<!-- The live region is mounted empty and permanently. Screen readers register
     a live region when it enters the DOM and announce SUBSEQUENT mutations, so
     inserting the region and its text in one go (the `{#if}` wrapping
     everything) announces unreliably across JAWS / NVDA / VoiceOver. Only the
     text inside is toggled; the visible toast is still conditional. -->
<div class="toast toast-top toast-end z-50 pointer-events-none" role="status" aria-live="polite">
	{#if appendNotice}
		<div class="alert alert-success py-2 px-3 text-sm shadow-lg" data-testid="append-confirmation">
			{appendNotice}
		</div>
	{/if}
</div>

<div class="max-w-4xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Pagination: cursor-based load-more</h1>
		<p class="text-sm opacity-70 mt-1">
			A log feed with {state.totalAtBoot} entries served in pages of
			{state.pageSize}. The server's loader returns
			<code>&#123; data, hasMore, cursor &#125;</code>; the framework
			detects the paginated shape and stamps the cursor on the next
			<code>loadMore()</code> call's subscribe envelope. New entries
			published via <code>appendLogEntry</code> land at the bottom of
			the visible list regardless of how many pages you've loaded.
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

	<!-- Append controls -->
	<section class="card bg-base-200" data-testid="append-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Append a new entry (lands at the bottom of the visible list)</h2>
			<form onsubmit={(e) => { e.preventDefault(); handleAppend() }} class="flex flex-wrap gap-2 items-end">
				<label class="flex flex-col gap-1 flex-1 min-w-[8rem]">
					<span class="opacity-70 text-xs">Severity</span>
					<select class="select select-bordered select-sm" bind:value={appendSeverity} disabled={appending} data-testid="append-severity">
						{#each state.severities as s (s)}
							<option value={s}>{s}</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 flex-1 min-w-[14rem]">
					<span class="opacity-70 text-xs">Message</span>
					<input class="input input-bordered input-sm" bind:value={appendMessage} maxlength="200" disabled={appending} data-testid="append-message" />
				</label>
				<button type="submit" class="btn btn-sm btn-primary" disabled={appending} data-testid="append-submit">
					{appending ? 'Appending...' : 'Append'}
				</button>
			</form>
		</div>
	</section>

	<!-- Log entries -->
	<section class="card bg-base-100 border border-base-300" data-testid="entries-section">
		<div class="card-body py-3 space-y-2">
			<h2 class="card-title text-sm">Entries <span class="font-normal">(<span data-testid="entries-count">{entries.length}</span>)</span></h2>
			{#if entries.length === 0}
				<p class="opacity-40 text-sm" data-testid="entries-empty">loading...</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono" data-testid="entries-list">
					{#each entries as e (e.id)}
						<!-- The fixed time/seq/badge columns consume a 320px row
						     whole; letting the message wrap to its own line keeps
						     the payload readable at phone widths. -->
						<li
							class="flex flex-wrap items-center gap-x-2 gap-y-0.5"
							class:append-highlight={highlightedId === e.id}
							data-testid="entry-row"
							data-entry-id={e.id}
							data-seq={e.seq}
						>
							<span class="opacity-50 w-20" data-testid="entry-time">{timeOf(e.ts)}</span>
							<span class="opacity-50 w-12 text-right">#{e.seq}</span>
							<span class="badge badge-xs {severityClass(e.severity)}" data-testid="entry-severity">{e.severity}</span>
							<span class="flex-1 min-w-40 truncate" data-testid="entry-message">{e.message}</span>
						</li>
					{/each}
				</ul>
			{/if}

			<div class="flex items-center gap-2 pt-2">
				<button
					class="btn btn-sm btn-ghost"
					onclick={handleLoadMore}
					disabled={loading || !hasMore}
					data-testid="load-more"
				>
					{loading ? 'Loading...' : (hasMore ? `Load more (next ${state.pageSize})` : 'No more entries')}
				</button>
				<span class="text-xs opacity-60" data-testid="has-more-state">hasMore: {hasMore ? 'true' : 'false'}</span>
				{#if lastError}
					<span class="text-xs text-error" data-testid="error">{lastError}</span>
				{/if}
			</div>
		</div>
	</section>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>logFeed = live.stream(topic, async (ctx) =&gt; &#123; ... return &#123; data, hasMore, cursor &#125; &#125;, &#123; merge: 'crud', key: 'id' &#125;)</code>.
			The loader reads <code>ctx.cursor</code> (null on initial
			subscribe, an opaque object on each <code>loadMore</code> call)
			and returns the next slice plus an explicit <code>hasMore</code>
			flag and the next-page cursor. The framework auto-detects the
			paginated shape from the return type.
		</p>
		<p>
			Client: <code>$logFeed</code> is a normal stream store; the
			extra surface is <code>logFeed.loadMore()</code> (returns
			<code>Promise&lt;hasMore&gt;</code>) and <code>logFeed.hasMore</code>
			(getter). New <code>'created'</code> publishes merge by id at the
			end of the list because the stream is configured with the
			default <code>prepend: false</code>.
		</p>
	</aside>
</div>

<style>
	.append-highlight {
		border-radius: 0.375rem;
		scroll-margin-block: 5rem;
		animation: append-flash 1.6s ease-out both;
	}

	@keyframes append-flash {
		0%, 35% { background: color-mix(in oklch, var(--color-success) 32%, transparent); }
		100% { background: transparent; }
	}

	@media (prefers-reduced-motion: reduce) {
		.append-highlight {
			animation: none;
			outline: 2px solid var(--color-success);
			outline-offset: 2px;
		}
	}
</style>
