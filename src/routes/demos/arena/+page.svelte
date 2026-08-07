<!--
	/demos/arena - area-of-interest culling on a smoothed-entity world.

	A 2400x1600 world, ~150 server-driven NPCs, one dot per visitor. Your
	client only receives the entities inside a 420-unit radius around your
	position (with LOD bands: near every tick, mid every 3rd, fringe every
	6th), and the HUD shows the live "receiving X of Y" ratio. Drive with
	WASD / arrow keys; your dot is predicted through the same shared
	`apply` the server runs, so it moves the frame you press.

	Spectate mode stops sending moves and pans the area of interest with
	`view.reportCenter(x, y)` - culling follows where the camera looks,
	not where your entity is.
-->
<script>
	import { onMount } from 'svelte'
	import MovePad from '$lib/components/MovePad.svelte'
	import { arena, population } from '$live/demos/arena'
	import { apply, WORLD_W, WORLD_H } from '../../../live/demos/arena.shared.js'

	// A 900x600 view exposes the 420-unit cull rim at the left/right edges
	// and the complete 300-unit LOD ring. The former 640x420 view sat wholly
	// inside the cull circle, making the demo's defining boundary invisible.
	const VIEW_W = 900
	const VIEW_H = 600
	const FRINGE_RADIUS = 300
	const INTEREST_RADIUS = 420
	const STEP = 6
	const PAN = 160

	// The client factory takes the SAME pure apply the server declared.
	// `initial` here is the pre-sync placeholder state; the first sync
	// reply replaces it with the server's authoritative spawn.
	const view = arena.smooth({ apply, initial: { x: WORLD_W / 2, y: WORLD_H / 2 } })
	$effect(() => () => view.destroy())

	// --- Population poll (the HUD's honest denominator) ---
	let total = $state(0)
	let errorMsg = $state('')

	onMount(() => {
		let alive = true
		const tick = async () => {
			try {
				const n = await population()
				if (alive) { total = n; errorMsg = '' }
			} catch (err) {
				if (alive) errorMsg = err?.message ?? 'population read failed'
			}
		}
		tick()
		const timer = setInterval(tick, 2000)
		return () => { alive = false; clearInterval(timer) }
	})

	// --- Input: held keys drained by a ~30Hz rAF-gated command loop ---
	const held = new Set()

	function keyFor(e) {
		switch (e.key) {
			case 'ArrowLeft': case 'a': case 'A': return 'left'
			case 'ArrowRight': case 'd': case 'D': return 'right'
			case 'ArrowUp': case 'w': case 'W': return 'up'
			case 'ArrowDown': case 's': case 'S': return 'down'
			default: return null
		}
	}

	function onKeydown(e) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
		const k = keyFor(e)
		if (!k) return
		held.add(k)
		e.preventDefault()
	}

	function onKeyup(e) {
		const k = keyFor(e)
		if (k) held.delete(k)
	}

	$effect(() => {
		let raf
		let last = 0
		const loop = (ts) => {
			raf = requestAnimationFrame(loop)
			if (ts - last < 33) return
			last = ts
			// The keys that move the entity keep working in spectate - they
			// pan the camera instead of going silently dead the moment the
			// mode that most needs navigation begins.
			if (spectating && held.size === 0 && camReportPending) {
				camReportPending = false
				view.reportCenter(camX, camY)
				return
			}
			if (held.size === 0) return
			let dx = 0
			let dy = 0
			const step = spectating ? PAN_KEY_STEP : STEP
			if (held.has('left')) dx -= step
			if (held.has('right')) dx += step
			if (held.has('up')) dy -= step
			if (held.has('down')) dy += step
			if (dx === 0 && dy === 0) return
			if (spectating) panBy(dx, dy)
			else view.command({ type: 'move', dx, dy })
		}
		raf = requestAnimationFrame(loop)
		return () => cancelAnimationFrame(raf)
	})

	// --- Spectate: pan the area of interest instead of the entity ---
	let spectating = $state(false)
	let camX = $state(WORLD_W / 2)
	let camY = $state(WORLD_H / 2)

	function toggleSpectate() {
		spectating = !spectating
		if (spectating) {
			camX = Math.round(view.local.x)
			camY = Math.round(view.local.y)
			view.reportCenter(camX, camY)
		} else {
			view.clearCenter()
		}
	}

	function pan(dx, dy) {
		camX = Math.max(0, Math.min(WORLD_W, camX + dx))
		camY = Math.max(0, Math.min(WORLD_H, camY + dy))
		view.reportCenter(camX, camY)
	}

	// The held-key pan runs at ~30Hz; reporting the center at that rate
	// would spam the interest pipeline for no visual gain. Report at most
	// every 100ms while panning, plus one trailing report when the keys
	// go quiet so the cull settles on the final camera position.
	const PAN_KEY_STEP = 12
	let camReportPending = false
	let lastCamReport = 0
	function panBy(dx, dy) {
		camX = Math.max(0, Math.min(WORLD_W, camX + dx))
		camY = Math.max(0, Math.min(WORLD_H, camY + dy))
		const now = performance.now()
		if (now - lastCamReport > 100) {
			lastCamReport = now
			view.reportCenter(camX, camY)
			camReportPending = false
		} else {
			camReportPending = true
		}
	}

	// World-scale texture: a 300-unit grid gives motion a reference in
	// empty stretches and makes "2400x1600" legible as distance. Lines
	// outside the viewBox are clipped by the svg itself.
	const GRID = 300
	const gridXs = Array.from({ length: Math.floor((WORLD_W - 1) / GRID) }, (_, i) => (i + 1) * GRID)
	const gridYs = Array.from({ length: Math.floor((WORLD_H - 1) / GRID) }, (_, i) => (i + 1) * GRID)

	// Minimap scale: 2400x1600 -> 180x120 (uniform 0.075).
	const MAP_W = 180
	const MAP_H = 120
	const mapX = (wx) => (wx * MAP_W) / WORLD_W
	const mapY = (wy) => (wy * MAP_H) / WORLD_H

	// --- World-to-screen, centered on your dot (or the spectate camera) ---
	const cam = $derived(spectating ? { x: camX, y: camY } : { x: view.local.x, y: view.local.y })

	function toX(wx) { return wx - cam.x + VIEW_W / 2 }
	function toY(wy) { return wy - cam.y + VIEW_H / 2 }
	function inView(s) {
		return Math.abs(s.x - cam.x) < VIEW_W / 2 + 20 && Math.abs(s.y - cam.y) < VIEW_H / 2 + 20
	}

	function opacityFor(freshness) {
		if (freshness === 'coasting') return 0.55
		if (freshness === 'stale') return 0.25
		return 1
	}

	const receiving = $derived(view.remote.size)
	const totalRemote = $derived(Math.max(0, total - 1))
	const pctCulled = $derived(
		totalRemote > 0 ? Math.max(0, Math.round(100 * (1 - receiving / totalRemote))) : 0
	)
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Arena: area-of-interest culling</h1>
		<p class="text-sm opacity-70 mt-1">
			A 2400x1600 world with ~150 server-driven NPCs, but your client only
			receives what is inside a 420-unit radius around you -
			<code>live.smooth(&#123; interest &#125;)</code> culls the rest per
			subscriber, with LOD bands throttling the fringe. Move with WASD or
			arrow keys; your dot is predicted through the shared
			<code>apply</code>, so it responds on the same frame.
		</p>
	</header>

	{#if errorMsg}
		<p class="text-error text-xs" data-testid="arena-error">{errorMsg}</p>
	{/if}

	<!-- An auto track sizes to the SVG's 300px replaced-element fallback
	     (the svg has only a viewBox), so w-full/max-w never engage; fr
	     tracks give the world view a definite width to fill. -->
	<div class="grid gap-4 @5xl:grid-cols-[3fr_2fr]">
		<div class="card bg-base-200">
			<div class="card-body p-3 space-y-2">
				<svg
					viewBox="0 0 {VIEW_W} {VIEW_H}"
					class="w-full max-w-[900px] bg-base-300 rounded-box select-none"
					data-testid="arena-viewport"
				>
					<title>Arena interest area centered on the camera</title>
					<desc>The dashed ring begins the low-frequency fringe at 300 units; delivery stops at the solid 420-unit ring.</desc>
					<!-- world walls, so the edge of the map is visible -->
					<rect
						x={toX(0)} y={toY(0)} width={WORLD_W} height={WORLD_H}
						class="fill-none stroke-base-content/20" stroke-width="3"
					/>
					{#each gridXs as gx (gx)}
						<line x1={toX(gx)} y1={toY(0)} x2={toX(gx)} y2={toY(WORLD_H)} class="stroke-base-content/10" data-testid="arena-grid-line" />
					{/each}
					{#each gridYs as gy (gy)}
						<line x1={toX(0)} y1={toY(gy)} x2={toX(WORLD_W)} y2={toY(gy)} class="stroke-base-content/10" data-testid="arena-grid-line" />
					{/each}
					<!-- Interest geometry is camera-relative, just like server culling. -->
					<circle
						cx={VIEW_W / 2} cy={VIEW_H / 2} r={INTEREST_RADIUS}
						class="fill-none stroke-primary opacity-70"
						stroke-width="2" vector-effect="non-scaling-stroke"
						data-testid="arena-cull-ring"
					/>
					<circle
						cx={VIEW_W / 2} cy={VIEW_H / 2} r={FRINGE_RADIUS}
						class="fill-none stroke-secondary opacity-70"
						stroke-width="2" stroke-dasharray="8 7" vector-effect="non-scaling-stroke"
						data-testid="arena-fringe-ring"
					/>
					{#each [...view.remote] as [key, s] (key)}
						{#if inView(s)}
							<circle
								cx={toX(s.x)} cy={toY(s.y)} r={s.npc ? 5 : 7}
								class={s.npc ? 'fill-secondary' : 'fill-accent'}
								opacity={opacityFor(view.freshness(key))}
								data-testid="arena-remote"
							/>
						{/if}
					{/each}
					<circle
						cx={toX(view.local.x)} cy={toY(view.local.y)} r="8"
						class="fill-primary stroke-primary-content" stroke-width="2"
						data-testid="arena-me"
						data-x={Math.round(view.local.x)}
						data-y={Math.round(view.local.y)}
					/>
					<!-- Minimap: the world you KNOW. Interest culling means the
					     client cannot honestly draw entities it is not receiving,
					     so the map shows the world frame, the camera window, and
					     the received set - the dark rest IS the culling. -->
					<g transform="translate({VIEW_W - MAP_W - 10}, 10)" data-testid="arena-minimap">
						<rect width={MAP_W} height={MAP_H} rx="3" class="fill-base-100/80 stroke-base-content/30" />
						{#each [...view.remote] as [key, s] (key)}
							<circle cx={mapX(s.x)} cy={mapY(s.y)} r="1.5" class={s.npc ? 'fill-secondary' : 'fill-accent'} data-testid="arena-minimap-entity" />
						{/each}
						<rect
							x={Math.max(0, Math.min(MAP_W - mapX(VIEW_W), mapX(cam.x - VIEW_W / 2)))}
							y={Math.max(0, Math.min(MAP_H - mapY(VIEW_H), mapY(cam.y - VIEW_H / 2)))}
							width={mapX(VIEW_W)} height={mapY(VIEW_H)}
							class="fill-none stroke-primary" stroke-width="1.5"
							data-testid="arena-minimap-view"
						/>
						<circle cx={mapX(view.local.x)} cy={mapY(view.local.y)} r="2.5" class="fill-primary" data-testid="arena-minimap-me" />
					</g>
				</svg>
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<label class="label cursor-pointer gap-2 py-0">
						<span class="opacity-70 text-xs">Spectate</span>
						<input
							type="checkbox"
							class="toggle toggle-sm"
							checked={spectating}
							onchange={toggleSpectate}
							data-testid="arena-spectate-toggle"
						/>
					</label>
					{#if spectating}
						<!-- A real d-pad: up above down, spatial mapping intact. -->
						<div class="grid grid-cols-3 gap-1 justify-items-center" data-testid="arena-pan-grid">
							<span></span>
							<button class="btn btn-sm btn-square pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => pan(0, -PAN)} aria-label="Pan up" data-testid="arena-pan-up">&uarr;</button>
							<span></span>
							<button class="btn btn-sm btn-square pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => pan(-PAN, 0)} aria-label="Pan left" data-testid="arena-pan-left">&larr;</button>
							<button class="btn btn-sm btn-square pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => pan(0, PAN)} aria-label="Pan down" data-testid="arena-pan-down">&darr;</button>
							<button class="btn btn-sm btn-square pointer-coarse:min-h-11 pointer-coarse:min-w-11" onclick={() => pan(PAN, 0)} aria-label="Pan right" data-testid="arena-pan-right">&rarr;</button>
						</div>
						<span class="font-mono opacity-60" data-testid="arena-cam">cam {camX}, {camY}</span>
						<span class="opacity-60">WASD / arrows pan too</span>
					{:else}
						<span class="opacity-50">WASD / arrows to move</span>
					{/if}
				</div>
				{#if !spectating}
					<!-- Touch feeds the same `held` set the keyboard does, so the rAF
					     loop drives both identically - continuous travel while pressed,
					     and diagonals when two buttons are held. -->
					<MovePad
						idPrefix="arena-move"
						onpress={(direction) => held.add(direction)}
						onrelease={(direction) => held.delete(direction)}
					/>
				{/if}
			</div>
		</div>

		<div class="card bg-base-100 border border-base-300">
			<div class="card-body py-3 space-y-2">
				<h2 class="card-title text-sm">Interest HUD</h2>
				<p class="font-mono text-sm" data-testid="arena-hud">
					receiving {receiving} of {totalRemote} entities ({pctCulled}% culled)
				</p>
				<div class="text-xs space-y-1 opacity-70">
					<p class="flex flex-wrap gap-x-3 gap-y-1 items-center" data-testid="arena-kind-legend">
						<span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-primary"></span> you</span>
						<span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-secondary"></span> NPC</span>
						<span class="inline-flex items-center gap-1"><span class="inline-block w-3 h-3 rounded-full bg-accent"></span> another visitor</span>
					</p>
					<p class="flex flex-wrap gap-x-3 gap-y-1 items-center" data-testid="arena-radius-legend">
						<span class="inline-flex items-center gap-1"><span class="inline-block w-5 border-t-2 border-dashed border-secondary"></span> fringe starts at 300</span>
						<span class="inline-flex items-center gap-1"><span class="inline-block w-5 border-t-2 border-primary"></span> delivery stops at 420</span>
					</p>
					<p>Freshness (per remote entity, <code>view.freshness(key)</code>):</p>
					<p class="flex gap-3 items-center">
						<span class="inline-block w-3 h-3 rounded-full bg-secondary"></span> live
						<span class="inline-block w-3 h-3 rounded-full bg-secondary/55 border border-base-content/30"></span> coasting
						<!-- Alpha on the FILL, not the element: the border must
						     stay visible where a quarter-opacity chip vanishes
						     into a dark card. -->
						<span class="inline-block w-3 h-3 rounded-full bg-secondary/25 border border-base-content/40" data-testid="arena-stale-swatch"></span> stale
					</p>
				</div>
				<p class="text-xs opacity-60" data-testid="arena-radius-note">
					Fringe entities (beyond 300 units) update every 6th tick, the
					mid ring every 3rd - watch dots dim as they coast between
					updates. The 420-unit rim is taller than this viewport, so some
					received dots remain beyond its top and bottom edges. Walk toward
					a quiet corner and the receiving count drops; the world does not.
				</p>
			</div>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>live.smooth()</code> on <code>demos:arena:main</code>,
			<code>tickMs: 50</code>, <code>broadcastHz: 20</code>. The pure
			<code>apply</code> lives in <code>arena.shared.js</code> and is
			imported by both the server and this page - that is the whole
			prediction contract. <code>onTick</code> ensures the NPC roster,
			<code>onMissing</code> drifts it, and
			<code>interest: &#123; radius: 420, lod &#125;</code> culls delivery
			per subscriber.
		</p>
		<p>
			Spectate pans the culled view via <code>view.reportCenter(x, y)</code>
			(the default <code>centerPolicy: 'any'</code> - right for a
			self-selecting surface like this; a competitive game would clamp with
			<code>'own-entity'</code>). On the 4-replica deploy the cull holds
			cluster-wide because <code>platform.smooth</code> is wired app-wide:
			one replica ticks the topic, the others relay and re-cull for their
			own subscribers.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/arena.js">arena.js</a>.
		</p>
	</aside>
</div>
