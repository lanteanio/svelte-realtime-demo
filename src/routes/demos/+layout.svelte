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

	const DEMOS = [
		{ slug: 'checkout',          title: 'Idempotency' },
		{ slug: 'counter-resume',    title: 'Reconnect-resume' },
		{ slug: 'chat',              title: 'Chat rooms' },
		{ slug: 'todos-rollback',    title: 'Optimistic rollback' },
		{ slug: 'denials',           title: 'Subscribe denials' },
		{ slug: 'pressure',          title: 'Admission-shedding' },
		{ slug: 'chaos',             title: 'Deterministic chaos' },
		{ slug: 'notifications',     title: 'Notifications' },
		{ slug: 'topk',              title: 'Top-K windows' },
		{ slug: 'news',              title: 'Newsroom' },
		{ slug: 'jobs',              title: 'Jobs / task runner' },
		{ slug: 'cluster-cron',      title: 'Cluster cron' },
		{ slug: 'upload',            title: 'Upload streaming' },
		{ slug: 'auctions',          title: 'Auctions' },
		{ slug: 'schema-evolution',  title: 'Schema evolution' },
		{ slug: 'flash-sales',       title: 'Flash sales' },
		{ slug: 'pagination',        title: 'Pagination' },
		{ slug: 'effect',            title: 'Effects / live.effect' },
		{ slug: 'from-seq',          title: 'Reconnect / fromSeq' },
		{ slug: 'collab-editor',     title: 'Collab selections' },
		{ slug: 'multiplayer',       title: 'Multiplayer lounge' },
		{ slug: 'kanban',            title: 'Kanban CRDT' },
		{ slug: 'offline',           title: 'Offline queue' },
		{ slug: 'arena',             title: 'Arena / AoI' },
		{ slug: 'shooter',           title: 'Shooter / lag-comp' },
		{ slug: 'lobbies',           title: 'Lobbies' },
		{ slug: 'tenants',           title: 'Multi-tenancy' },
		{ slug: 'flags',             title: 'Feature flags' },
		{ slug: 'alarms',            title: 'Durable alarms' },
		{ slug: 'forget',            title: 'Right to erasure' },
		{ slug: 'privacy',           title: 'Aggregate privacy' },
		{ slug: 'ops',               title: 'Ops dashboard' },
		{ slug: 'outbound-webhooks', title: 'Outbound webhooks' },
		{ slug: 'phases',            title: 'Phases + batch' }
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
			<div class="demos-section-label">Demos</div>
			<ul class="demos-list">
				{#each DEMOS as d (d.slug)}
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
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.demos-list > li { flex-shrink: 0; }
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
		.demos-list > li { flex-shrink: 1; }
		.demos-link {
			white-space: normal;
		}
	}
</style>
