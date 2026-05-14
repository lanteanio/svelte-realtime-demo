<!--
	/demos/news - a live newsroom showcasing four realtime primitives:
	live.cron drives a 1Hz view firehose; live.aggregate({ windows })
	maintains three trending leaderboards (last30s sliding, thisMinute
	tumbling, lifetime); live.derived computes a stats strip; and
	live.webhook accepts HMAC-signed external publishes.

	Editorial loop: type a headline + summary, click Publish. The page
	asks the server for a signed payload via signPublish, then POSTs
	body + signature directly to /api/demos/news/webhook. The webhook
	handler verifies the signature, transforms the payload, publishes
	to the stories topic; every subscribing tab sees the story land
	in the list. The firehose biases toward the newest 3 stories so a
	freshly-published headline crosses the trending leaderboards within
	a few seconds.
-->
<script>
	import { onMount } from 'svelte'
	import {
		newsStories,
		trending,
		newsStats,
		signPublish,
		setSpeed,
		myNewsState
	} from '$live/demos/news'

	let storyList = $state([])
	let speedVal = $state(5)
	let maxHeadlineLen = $state(80)
	let maxSummaryLen = $state(200)

	let last30s = $state({ counts: {}, top: [] })
	let thisMinute = $state({ counts: {}, top: [] })
	let lifetime = $state({ counts: {}, top: [] })
	let stats = $state({ totalStories: 0, totalViews: 0, newestId: null, newestHeadline: null, newestPublishedAt: null })

	let headline = $state('')
	let summary = $state('')
	let publishing = $state(false)
	let publishError = $state('')
	let publishOk = $state('')

	$effect(() => {
		const offs = [
			newsStories.subscribe((v) => { storyList = v ?? [] }),
			trending.last30s.subscribe((v) => { last30s = v ?? { counts: {}, top: [] } }),
			trending.thisMinute.subscribe((v) => { thisMinute = v ?? { counts: {}, top: [] } }),
			trending.lifetime.subscribe((v) => { lifetime = v ?? { counts: {}, top: [] } }),
			newsStats.subscribe((v) => { stats = v ?? stats })
		]
		return () => { for (const off of offs) off() }
	})

	onMount(async () => {
		const s = await myNewsState()
		speedVal = s?.speed ?? 5
		maxHeadlineLen = s?.maxHeadlineLen ?? 80
		maxSummaryLen = s?.maxSummaryLen ?? 200
	})

	const sortedStories = $derived(
		[...storyList].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
	)

	const headlineById = $derived.by(() => {
		const map = new Map()
		for (const story of storyList) map.set(story.id, story.headline)
		return map
	})

	function nameById(id) {
		return headlineById.get(id) ?? id
	}

	async function handleSpeedChange(e) {
		speedVal = Number(e.target.value)
		await setSpeed(speedVal)
	}

	async function handlePublish(e) {
		e.preventDefault()
		const h = headline.trim()
		if (h.length === 0 || publishing) return
		publishing = true
		publishError = ''
		publishOk = ''
		try {
			const signed = await signPublish({ headline: h, summary: summary.trim() })
			const res = await fetch('/api/demos/news/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-news-signature': signed.signature
				},
				body: signed.body
			})
			if (!res.ok) {
				const text = await res.text().catch(() => '')
				throw new Error(`webhook returned ${res.status}${text ? ': ' + text : ''}`)
			}
			publishOk = 'Published.'
			headline = ''
			summary = ''
		} catch (err) {
			publishError = err?.message ?? String(err)
		} finally {
			publishing = false
		}
	}

	function fmtTime(iso) {
		if (!iso) return ''
		const d = typeof iso === 'number' ? new Date(iso) : new Date(iso)
		if (Number.isNaN(d.getTime())) return ''
		return d.toLocaleTimeString()
	}

	const TRENDING_PANELS = [
		{ key: 'last30s',    title: 'Trending now',  subtitle: 'sliding 30s, 3s hops', testid: 'lb-news-last30s' },
		{ key: 'thisMinute', title: 'This minute',   subtitle: 'tumbling per-minute',  testid: 'lb-news-thisMinute' },
		{ key: 'lifetime',   title: 'All-time',      subtitle: 'never resets',         testid: 'lb-news-lifetime' }
	]
</script>

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>

		<h1 class="text-2xl font-bold mt-2">Newsroom: cron + windowed aggregate + derived + webhook</h1>
		<p class="text-sm opacity-70 mt-1">
			Four realtime primitives in one page. A 1Hz <code>live.cron</code> firehose feeds a windowed
			<code>live.aggregate</code> with three trending slices. A <code>live.derived</code> stats strip
			tracks story / view counts. The Publish form below routes through
			<code>live.webhook</code>: the server signs a payload, the page POSTs it to
			<code>/api/demos/news/webhook</code>, the framework verifies the signature and publishes a
			story event to every subscriber.
		</p>
	</header>

	<div class="card bg-base-200" data-testid="news-stats-strip">
		<div class="card-body py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
			<div>
				<div class="text-xs opacity-60">Stories</div>
				<div class="font-mono text-lg" data-testid="stat-totalStories">{stats.totalStories}</div>
			</div>
			<div>
				<div class="text-xs opacity-60">Total views</div>
				<div class="font-mono text-lg" data-testid="stat-totalViews">{stats.totalViews}</div>
			</div>
			<div class="col-span-2">
				<div class="text-xs opacity-60">Newest headline</div>
				<div class="truncate" data-testid="stat-newestHeadline">
					{stats.newestHeadline ?? '-'}
					{#if stats.newestPublishedAt}
						<span class="text-xs opacity-50 ml-2">{fmtTime(stats.newestPublishedAt)}</span>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<div class="card bg-base-200">
		<div class="card-body py-3 space-y-2">
			<div class="flex flex-wrap gap-3 items-end">
				<label class="form-control flex-1 min-w-[12rem]">
					<span class="label-text text-xs">View firehose ({speedVal} events/sec)</span>
					<input
						type="range"
						class="range range-sm"
						min="0" max="50" step="1"
						value={speedVal}
						onchange={handleSpeedChange}
						data-testid="news-speed-input"
					/>
				</label>
			</div>
		</div>
	</div>

	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
		{#each TRENDING_PANELS as panel (panel.key)}
			{@const data = panel.key === 'last30s' ? last30s : panel.key === 'thisMinute' ? thisMinute : lifetime}
			<div class="card bg-base-100 border border-base-300" data-testid={panel.testid}>
				<div class="card-body py-3 space-y-2">
					<div class="flex justify-between items-baseline">
						<h2 class="card-title text-sm">{panel.title}</h2>
						<span class="text-xs opacity-50">{panel.subtitle}</span>
					</div>
					{#if !data?.top?.length}
						<p class="opacity-40 text-xs py-3" data-testid="{panel.testid}-empty">Waiting for first events...</p>
					{:else}
						{@const leaderCount = data.top[0].count}
						<ol class="space-y-1" data-testid="{panel.testid}-rows">
							{#each data.top as entry, idx (entry.storyId)}
								<li class="flex items-center gap-2 text-xs" data-testid="{panel.testid}-row">
									<span class="opacity-50 font-mono w-4">{idx + 1}</span>
									<span class="flex-1 truncate" data-testid="{panel.testid}-name">{nameById(entry.storyId)}</span>
									<span class="font-mono opacity-60 w-10 text-right" data-testid="{panel.testid}-count">{entry.count}</span>
									<div class="w-12 h-2 bg-base-200 rounded overflow-hidden">
										<div class="h-full bg-primary" style:width="{leaderCount > 0 ? (entry.count / leaderCount) * 100 : 0}%"></div>
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<form class="card bg-base-100 border border-base-300 lg:col-span-1" onsubmit={handlePublish} data-testid="news-publish-form">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Publish via webhook</h2>
				<p class="text-xs opacity-60 leading-snug">
					Server signs the payload, page POSTs it to <code>/api/demos/news/webhook</code>.
					HMAC verified at the bridge, then published to every subscriber.
				</p>
				<label class="form-control">
					<span class="label-text text-xs">Headline</span>
					<input
						class="input input-sm input-bordered"
						bind:value={headline}
						maxlength={maxHeadlineLen}
						placeholder="What just happened?"
						data-testid="news-headline-input"
					/>
				</label>
				<label class="form-control">
					<span class="label-text text-xs">Summary (optional)</span>
					<textarea
						class="textarea textarea-sm textarea-bordered text-xs"
						bind:value={summary}
						maxlength={maxSummaryLen}
						rows="2"
						placeholder="One sentence the wire could pick up."
						data-testid="news-summary-input"
					></textarea>
				</label>
				<button
					type="submit"
					class="btn btn-primary btn-sm"
					disabled={publishing || headline.trim().length === 0}
					data-testid="news-publish-button"
				>
					{publishing ? 'Publishing...' : 'Publish'}
				</button>
				{#if publishError}
					<p class="text-xs text-error" data-testid="news-publish-error">{publishError}</p>
				{/if}
				{#if publishOk}
					<p class="text-xs text-success" data-testid="news-publish-ok">{publishOk}</p>
				{/if}
			</div>
		</form>

		<div class="card bg-base-100 border border-base-300 lg:col-span-2" data-testid="news-stories">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Stories ({sortedStories.length})</h2>
				{#if sortedStories.length === 0}
					<p class="opacity-40 text-xs" data-testid="news-stories-empty">No stories yet.</p>
				{:else}
					<ul class="space-y-2 max-h-80 overflow-y-auto pr-1">
						{#each sortedStories as story (story.id)}
							<li class="border-b border-base-200 pb-2 last:border-0" data-testid="news-story">
								<div class="flex justify-between gap-2 items-baseline">
									<span class="font-medium text-sm" data-testid="news-story-headline">{story.headline}</span>
									<span class="text-xs opacity-50 shrink-0">{fmtTime(story.publishedAt)}</span>
								</div>
								{#if story.summary}
									<p class="text-xs opacity-70 mt-0.5" data-testid="news-story-summary">{story.summary}</p>
								{/if}
								{#if story.source === 'webhook'}
									<span class="badge badge-xs badge-primary mt-1">webhook</span>
								{:else}
									<span class="badge badge-xs badge-ghost mt-1">seed</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>live.aggregate('demos:news:view', &#123; counts, top &#125;, &#123; topic, windows &#125;)</code>
			declares all three trending windows. Output topics are <code>demos:news:topk:&#123;windowName&#125;</code>;
			the page subscribes to each via the vite-plugin-generated <code>trending.last30s</code> /
			<code>trending.thisMinute</code> / <code>trending.lifetime</code> namespace exports.
		</p>
		<p>
			<code>live.derived(['demos:news:topk:lifetime', 'demos:news:stories'], ...)</code> recomputes
			when the lifetime window publishes (1Hz under default firehose) or a new story arrives. 250ms
			debounce coalesces a webhook publish + the same-tick aggregate publish into one recompute.
		</p>
		<p>
			<code>live.webhook</code> verifies an HMAC-SHA256 signature on the request body and shapes the
			payload into a <code>created</code> event the framework auto-publishes to the stories topic.
			Sample external integration shape: a CMS holding the shared secret would POST to the same
			endpoint without involving the demo's <code>signPublish</code> RPC.
		</p>
	</aside>
</div>
