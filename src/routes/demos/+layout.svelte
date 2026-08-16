<!--
	Nested layout for /demos/* pages. Renders a left-side switcher
	listing every demo so users can hop between them without going
	through the home page. The current page is highlighted; the
	sidebar is sticky-positioned so it stays put while the main
	column scrolls.

	Below 1024px the switcher renders as a horizontal scroller at the
	top of the page. Keeping the 640-1023px tablet band rail-free means
	child pages' viewport breakpoints describe their actual content width;
	the fixed 13rem sidebar would otherwise make every sm:/md: layout lie.

	Layout uses a scoped `<style>` block instead of Tailwind responsive
	variants so the breakpoint behaves the same regardless of the
	utility-class compilation pipeline.
-->
<script>
	import { page } from '$app/state'

	let { children } = $props()

	// Grouped, not flat. Thirty-four entries under one faded label is a linear
	// read whose ordering principle is invisible - the labels mix concepts
	// ("Idempotency"), API names ("live.effect"), and products ("Ops
	// dashboard"), so nothing about a row tells you where you are in the list.
	// The curated order is pedagogical and is preserved exactly: every group is
	// a contiguous run of it, so the groups name the districts the order
	// already had without reordering a single entry.
	const GROUPS = [
		{
			label: 'Delivery basics',
			demos: [
				{ slug: 'checkout',          title: 'Idempotency' },
				{ slug: 'counter-resume',    title: 'Reconnect-resume' },
				{ slug: 'chat',              title: 'Chat rooms' },
				{ slug: 'todos-rollback',    title: 'Optimistic rollback' },
				{ slug: 'denials',           title: 'Subscribe denials' },
				{ slug: 'pressure',          title: 'Admission-shedding' },
				{ slug: 'chaos',             title: 'Deterministic chaos' }
			]
		},
		{
			label: 'Streams and jobs',
			demos: [
				{ slug: 'notifications',     title: 'Notifications' },
				{ slug: 'topk',              title: 'Top-K windows' },
				{ slug: 'news',              title: 'Newsroom' },
				{ slug: 'jobs',              title: 'Jobs / task runner' },
				{ slug: 'cluster-cron',      title: 'Cluster cron' },
				{ slug: 'upload',            title: 'Upload streaming' }
			]
		},
		{
			label: 'Stream consistency',
			demos: [
				{ slug: 'auctions',          title: 'Auctions' },
				{ slug: 'schema-evolution',  title: 'Schema evolution' },
				{ slug: 'flash-sales',       title: 'Flash sales' },
				{ slug: 'pagination',        title: 'Pagination' },
				{ slug: 'effect',            title: 'live.effect / one publish, three streams' },
				{ slug: 'from-seq',          title: 'Reconnect / fromSeq' }
			]
		},
		{
			label: 'Collaboration',
			demos: [
				{ slug: 'collab-editor',     title: 'Collab selections' },
				{ slug: 'multiplayer',       title: 'Multiplayer lounge' },
				{ slug: 'kanban',            title: 'Kanban CRDT' },
				{ slug: 'offline',           title: 'Offline queue' }
			]
		},
		{
			label: 'Realtime games',
			demos: [
				{ slug: 'arena',             title: 'Arena / AoI' },
				{ slug: 'shooter',           title: 'Shooter / lag-comp' },
				{ slug: 'lobbies',           title: 'Lobbies' }
			]
		},
		{
			label: 'Governance and ops',
			demos: [
				{ slug: 'tenants',           title: 'Multi-tenancy' },
				{ slug: 'flags',             title: 'Feature flags' },
				{ slug: 'alarms',            title: 'Durable alarms' },
				{ slug: 'forget',            title: 'Right to erasure' },
				{ slug: 'privacy',           title: 'Aggregate privacy' },
				{ slug: 'ops',               title: 'Ops dashboard' },
				{ slug: 'outbound-webhooks', title: 'Outbound webhooks' },
				{ slug: 'phases',            title: 'Phases + batch' }
			]
		}
	]

	const currentSlug = $derived.by(() => {
		const m = page.url.pathname.match(/^\/demos\/([^/]+)/)
		return m ? m[1] : ''
	})

	// Neither the sidebar nor the sub-1024 scroller moves on its own, so a
	// late-list demo would otherwise show a nav parked at the top/left with
	// the active entry offscreen.
	//
	// Scrolling is confined to the nav's own scroll container rather than
	// delegated to scrollIntoView. Above 1024 the rail is `position: fixed`
	// with its own overflow, so scrollIntoView would be contained - but below
	// 1024 the switcher is an in-flow strip at the top of the document, and
	// scrollIntoView there scrolls the DOCUMENT whenever the strip is out of
	// view. That would fight SvelteKit's scroll restoration on back-navigation
	// and yank a reader mid-page back to the top on any re-run.
	// Which element actually scrolls depends on the breakpoint: above 1024 the
	// rail is the vertical scroller and the list does not scroll at all; below
	// it the list is a horizontal strip and the rail does not scroll. Walking
	// the ancestors and testing each axis covers both without encoding the
	// breakpoint here a third time.
	// Below 1024 the nav is a horizontal strip about 4.5 viewports wide with no
	// scrollbar, no fade, and no chevron: the only hint that 30 more entries
	// exist is whether a label happens to be cut mid-word at the edge, which is
	// an accident of viewport width against label widths. A phone visitor can
	// read three items as the whole catalog. `data-overflow` says which
	// directions have more, and the mask below turns that into something
	// visible on every width rather than on the lucky ones.
	let strip = $state(/** @type {HTMLElement | null} */ (null))
	let overflow = $state('none')

	function measureOverflow() {
		if (!strip) return
		// Sub-pixel layout makes an exactly-scrolled-to-the-end strip report a
		// fractional remainder, so a bare `>` would leave the fade on forever at
		// the end of the strip - which says "there is more" when there is not.
		const slack = 1
		const max = strip.scrollWidth - strip.clientWidth
		if (max <= slack) { overflow = 'none'; return }
		const more = { left: strip.scrollLeft > slack, right: strip.scrollLeft < max - slack }
		overflow = more.left && more.right ? 'both' : more.left ? 'left' : more.right ? 'right' : 'none'
	}

	$effect(() => {
		if (!strip) return
		measureOverflow()
		// The strip's own resize matters as much as the window's: it is the
		// element that stops scrolling at 1024, and a window listener alone
		// would leave a stale mask after the breakpoint change.
		const observer = new ResizeObserver(measureOverflow)
		observer.observe(strip)
		return () => observer.disconnect()
	})

	$effect(() => {
		if (!currentSlug) return
		const link = document.querySelector(`[data-testid="demos-nav-link-${currentSlug}"]`)
		if (!(link instanceof HTMLElement)) return
		const root = link.closest('.demos-aside')
		if (!(root instanceof HTMLElement)) return
		for (let node = link.parentElement; node instanceof HTMLElement; node = node.parentElement) {
			const box = node.getBoundingClientRect()
			const linkBox = link.getBoundingClientRect()
			if (node.scrollHeight > node.clientHeight && (linkBox.top < box.top || linkBox.bottom > box.bottom)) {
				node.scrollTop += linkBox.top - box.top
			}
			if (node.scrollWidth > node.clientWidth && (linkBox.left < box.left || linkBox.right > box.right)) {
				node.scrollLeft += linkBox.left - box.left
			}
			if (node === root) break
		}
	})
</script>

<div class="demos-shell">
	<aside class="demos-aside" data-testid="demos-nav">
		<nav class="demos-nav">
			<a href="/" class="demos-home-link">&larr; Home</a>
			<div
				class="demos-list"
				data-testid="demos-nav-list"
				data-overflow={overflow}
				bind:this={strip}
				onscroll={measureOverflow}
			>
				{#each GROUPS as group (group.label)}
					<!-- display:contents, so the label and the list join the strip's
					     own flex row below 1024 and its column above. A nested box
					     here would make the groups scroll independently. -->
					<div class="demos-group">
						<div class="demos-section-label" data-testid="demos-nav-group">{group.label}</div>
						<ul class="demos-group-list">
							{#each group.demos as d (d.slug)}
								{@const isActive = d.slug === currentSlug}
								<li>
									<a
										href="/demos/{d.slug}"
										class="demos-link"
										class:active={isActive}
										data-testid="demos-nav-link-{d.slug}"
										aria-current={isActive ? 'page' : undefined}
									>
										{d.title}
									</a>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		</nav>
	</aside>

	<div class="demos-content">
		{@render children()}
	</div>
</div>

<style>
	.demos-shell {
		display: block;
		overflow-x: hidden;
	}
	.demos-aside {
		background: var(--color-base-100);
	}
	.demos-nav {
		padding: 0.5rem;
	}
	.demos-home-link {
		display: block;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		line-height: 1rem;
		opacity: 0.6;
	}
	.demos-home-link:hover { opacity: 1; }
	.demos-section-label {
		font-size: 0.7rem;
		line-height: 1rem;
		opacity: 0.4;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 0 0.5rem;
		margin: 0.5rem 0 0.25rem 0;
		display: none;
	}
	.demos-list {
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
	}
	.demos-group { display: contents; }
	.demos-group-list {
		display: flex;
		gap: 0.25rem;
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.demos-group-list > li { flex-shrink: 0; }
	/*
	 * The clipped edge, made visible. Fading the strip's own content is what
	 * says "this continues" on every width, rather than only on the widths
	 * where a label happens to be cut mid-word. Driven by measurement, so it
	 * is absent at the end of the strip instead of promising more forever.
	 */
	.demos-list[data-overflow='right'] {
		mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent);
	}
	.demos-list[data-overflow='left'] {
		mask-image: linear-gradient(to left, #000 calc(100% - 2rem), transparent);
	}
	.demos-list[data-overflow='both'] {
		mask-image: linear-gradient(to right, transparent, #000 2rem, #000 calc(100% - 2rem), transparent);
	}
	.demos-link {
		display: block;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		white-space: nowrap;
		border-left: 2px solid transparent;
		color: var(--color-base-content);
		text-decoration: none;
		transition: background-color 120ms ease, color 120ms ease;
	}
	.demos-link:hover {
		background: color-mix(in oklch, var(--color-base-200) 60%, transparent);
	}
	.demos-link.active {
		background: var(--color-base-200);
		border-left-color: var(--color-primary);
		font-weight: 600;
	}
	/* Coarse pointers: pad the nav links so line-height plus padding reaches the 44px touch floor. */
	@media (pointer: coarse) {
		.demos-link {
			padding: 0.75rem;
		}
		.demos-home-link {
			padding: 0.875rem 0.75rem;
		}
	}
	.demos-content {
		min-width: 0;
		flex: 1 1 0;
		overflow-x: auto;
		/*
		 * The content column is what demo layouts actually get - 208px less
		 * than the viewport once the sidebar is fixed at >=1024. Making it a
		 * container lets pages key their multi-column variants (@2xl:, @3xl:,
		 * @5xl:, ...) on the space the content really has instead of the
		 * viewport, so no band can force columns into starved tracks.
		 */
		container-type: inline-size;
	}
	/*
	 * The closing explainer aside on every demo page is authored text-xs +
	 * opacity-50 - a metadata treatment applied to dense API teaching copy. At
	 * 12px that measures about 3.4:1 on light, under the 4.5:1 AA bar; this
	 * lifts it to roughly 6.5:1 light and 7.9:1 dark. Matched on that utility
	 * signature rather than blanket-restyling text-xs, so timestamps, compact
	 * status labels, and other genuine metadata stay compact. Page intro
	 * paragraphs already ship text-sm + opacity-70 and need no rule.
	 *
	 * Component <style> output is unlayered and so beats Tailwind's layered
	 * utilities regardless of specificity - which is what lets this override
	 * opacity-50 at all.
	 */
	:global(.demos-content aside.text-xs.opacity-50.leading-relaxed) {
		font-size: 0.875rem;
		opacity: 0.7;
	}

	@media (min-width: 1024px) {
		.demos-shell {
			display: block;
		}
		.demos-aside {
			position: fixed;
			top: 3rem;
			left: 0;
			bottom: 0;
			width: 13rem;
			overflow-y: auto;
			border-right: 1px solid var(--color-base-300);
			z-index: 10;
		}
		.demos-content {
			margin-left: 13rem;
			overflow-x: auto;
		}
		.demos-section-label { display: block; }
		.demos-list {
			flex-direction: column;
			overflow-x: visible;
		}
		.demos-group-list {
			flex-direction: column;
		}
		.demos-group-list > li { flex-shrink: 1; }
		.demos-link {
			white-space: normal;
		}
	}
</style>
