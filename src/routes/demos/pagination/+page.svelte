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
	import { onMount } from 'svelte'
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

	async function handleAppend() {
		if (appending) return
		appending = true
		try {
			await appendLogEntry({ severity: appendSeverity, message: appendMessage.trim() || 'manual entry' })
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
				<label class="form-control flex-1 min-w-[8rem]">
					<span class="label-text text-xs">Severity</span>
					<select class="select select-bordered select-sm" bind:value={appendSeverity} disabled={appending} data-testid="append-severity">
						{#each state.severities as s (s)}
							<option value={s}>{s}</option>
						{/each}
					</select>
				</label>
				<label class="form-control flex-1 min-w-[14rem]">
					<span class="label-text text-xs">Message</span>
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
			<h2 class="card-title text-sm">Entries (<span data-testid="entries-count">{entries.length}</span>)</h2>
			{#if entries.length === 0}
				<p class="opacity-40 text-sm" data-testid="entries-empty">loading...</p>
			{:else}
				<ul class="space-y-1 text-xs font-mono" data-testid="entries-list">
					{#each entries as e (e.id)}
						<li class="flex items-center gap-2" data-testid="entry-row">
							<span class="opacity-50 w-20">{timeOf(e.ts)}</span>
							<span class="opacity-50 w-12 text-right">#{e.seq}</span>
							<span class="badge badge-xs {severityClass(e.severity)}" data-testid="entry-severity">{e.severity}</span>
							<span class="flex-1 truncate" data-testid="entry-message">{e.message}</span>
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
					{loading ? 'Loading...' : (hasMore ? `Load older (${state.pageSize} more)` : 'No more entries')}
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
