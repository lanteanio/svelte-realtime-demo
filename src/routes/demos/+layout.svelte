<!--
	Nested layout for /demos/* pages. Renders a left-side switcher
	listing every demo so users can hop between them without going
	through the home page. The current page is highlighted; the
	sidebar is sticky-positioned so it stays put while the main
	column scrolls.

	Below 640px the switcher renders as a horizontal scroller at the
	top of the page so mobile readers can still skim demos.

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
		{ slug: 'pressure',          title: 'Pressure / admission' },
		{ slug: 'chaos',             title: 'Deterministic chaos' },
		{ slug: 'notifications',     title: 'Push + reply + cron' },
		{ slug: 'topk',              title: 'Top-K windows' },
		{ slug: 'news',              title: 'Newsroom' },
		{ slug: 'jobs',              title: 'Task runner' },
		{ slug: 'cluster-cron',      title: 'Cluster cron' },
		{ slug: 'upload',            title: 'Streaming upload' },
		{ slug: 'auctions',          title: 'Auctions' },
		{ slug: 'schema-evolution',  title: 'Schema evolution' },
		{ slug: 'flash-sales',       title: 'Flash sales' },
		{ slug: 'pagination',        title: 'Pagination' },
		{ slug: 'effect',            title: 'live.effect' },
		{ slug: 'from-seq',          title: 'delta.fromSeq' },
		{ slug: 'collab-editor',     title: 'CRDT selections' },
		{ slug: 'multiplayer',       title: 'Multiplayer lounge' },
		{ slug: 'kanban',            title: 'CRDT kanban' },
		{ slug: 'offline',           title: 'Offline queue' },
		{ slug: 'arena',             title: 'AoI arena' },
		{ slug: 'shooter',           title: 'Lag-comp shooter' },
		{ slug: 'lobbies',           title: 'Lobbies' },
		{ slug: 'tenants',           title: 'Multi-tenancy' },
		{ slug: 'flags',             title: 'Feature flags' },
		{ slug: 'alarms',            title: 'Durable alarms' },
		{ slug: 'forget',            title: 'Right to erasure' },
		{ slug: 'privacy',           title: 'Aggregate privacy' },
		{ slug: 'ops',               title: 'Ops dashboard' },
		{ slug: 'outbound-webhooks', title: 'Outbound webhooks' },
		{ slug: 'phases',            title: 'Attach + batch' }
	]

	const currentSlug = $derived.by(() => {
		const m = page.url.pathname.match(/^\/demos\/([^/]+)/)
		return m ? m[1] : ''
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
	.demos-content {
		min-width: 0;
		flex: 1 1 0;
		overflow-x: auto;
	}

	@media (min-width: 640px) {
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
