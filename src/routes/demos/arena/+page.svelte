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

	// Every pad button is placed explicitly. Grid sparse auto-placement leaves
	// the cursor after the one definite-column item, so mixing `grid-column` on
	// `up` with auto-placed siblings scatters left/down/right one cell onward.
	const PAD_KEYS = [
		{ dir: 'up', label: 'Move up', glyph: '↑' },
		{ dir: 'left', label: 'Move left', glyph: '←' },
		{ dir: 'down', label: 'Move down', glyph: '↓' },
		{ dir: 'right', label: 'Move right', glyph: '→' }
	]

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

	// Touch feeds the same `held` set the keyboard does, so the rAF loop below
	// drives both identically - continuous travel while pressed, and diagonals
	// when two buttons are held. A per-tap command would move STEP (6) units
	// once, needing ~150 taps to cross the 900-unit viewport.
	function pressDirection(e, direction) {
		e.preventDefault()
		// Capture is best-effort: it keeps the release event on the button
		// when a finger slides off, but setPointerCapture THROWS for a
		// pointerId with no active pointer (synthetic events, some stale
		// cancel paths) - and a throw here would swallow the held.add below.
		try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* no active pointer */ }
		held.add(direction)
	}

	function releaseDirection(direction) {
		held.delete(direction)
	}

	$effect(() => {
		let raf
		let last = 0
		const loop = (ts) => {
			raf = requestAnimationFrame(loop)
			if (ts - last < 33) return
			last = ts
			if (spectating || held.size === 0) return
			let dx = 0
			let dy = 0
			if (held.has('left')) dx -= STEP
			if (held.has('right')) dx += STEP
			if (held.has('up')) dy -= STEP
			if (held.has('down')) dy += STEP
			if (dx !== 0 || dy !== 0) view.command({ type: 'move', dx, dy })
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
	<div class="grid gap-4 lg:grid-cols-[3fr_2fr]">
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
				</svg>
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<label class="label cursor-pointer gap-2 py-0">
						<span class="label-text text-xs">Spectate</span>
						<input
							type="checkbox"
							class="toggle toggle-sm"
							checked={spectating}
							onchange={toggleSpectate}
							data-testid="arena-spectate-toggle"
						/>
					</label>
					{#if spectating}
						<div class="join">
							<button class="btn btn-xs join-item" onclick={() => pan(-PAN, 0)} data-testid="arena-pan-left">&larr;</button>
							<button class="btn btn-xs join-item" onclick={() => pan(0, -PAN)} data-testid="arena-pan-up">&uarr;</button>
							<button class="btn btn-xs join-item" onclick={() => pan(0, PAN)} data-testid="arena-pan-down">&darr;</button>
							<button class="btn btn-xs join-item" onclick={() => pan(PAN, 0)} data-testid="arena-pan-right">&rarr;</button>
						</div>
						<span class="font-mono opacity-60" data-testid="arena-cam">cam {camX}, {camY}</span>
					{:else}
						<span class="opacity-50">WASD / arrows to move</span>
					{/if}
				</div>
				{#if !spectating}
					<div class="arena-move-pad" role="group" aria-labelledby="arena-move-label" data-testid="arena-move-pad">
						<span class="arena-move-label" id="arena-move-label">Touch controls</span>
						{#each PAD_KEYS as pad (pad.dir)}
							<button
								type="button"
								class="btn btn-sm btn-square arena-move-{pad.dir}"
								aria-label={pad.label}
								data-testid="arena-move-{pad.dir}"
								onpointerdown={(e) => pressDirection(e, pad.dir)}
								onpointerup={() => releaseDirection(pad.dir)}
								onpointercancel={() => releaseDirection(pad.dir)}
								onpointerleave={() => releaseDirection(pad.dir)}
							>{pad.glyph}</button>
						{/each}
					</div>
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
					<p class="flex flex-wrap gap-x-3 gap-y-1 items-center" data-testid="arena-radius-legend">
						<span class="inline-flex items-center gap-1"><span class="inline-block w-5 border-t-2 border-dashed border-secondary"></span> fringe starts at 300</span>
						<span class="inline-flex items-center gap-1"><span class="inline-block w-5 border-t-2 border-primary"></span> delivery stops at 420</span>
					</p>
					<p>Freshness (per remote entity, <code>view.freshness(key)</code>):</p>
					<p class="flex gap-3 items-center">
						<span class="inline-block w-3 h-3 rounded-full bg-secondary"></span> live
						<span class="inline-block w-3 h-3 rounded-full bg-secondary opacity-55"></span> coasting
						<span class="inline-block w-3 h-3 rounded-full bg-secondary opacity-25"></span> stale
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

<style>
	.arena-move-pad {
		display: none;
		grid-template-columns: repeat(3, 2.75rem);
		gap: 0.375rem;
		justify-content: center;
	}

	.arena-move-label {
		grid-column: 1 / -1;
		text-align: center;
		font-size: 0.75rem;
		opacity: 0.7;
	}

	/*
	 * Every cell is placed explicitly. Placing only `up` and letting the rest
	 * auto-flow leaves the placement cursor past the definite item, so left/
	 * down/right each land one cell onward and the pad renders as a scrambled
	 * cross with a hole where left belongs.
	 */
	.arena-move-up    { grid-area: 2 / 2; }
	.arena-move-left  { grid-area: 3 / 1; }
	.arena-move-down  { grid-area: 3 / 2; }
	.arena-move-right { grid-area: 3 / 3; }

	.arena-move-pad .btn {
		width: 2.75rem;
		height: 2.75rem;
		min-height: 2.75rem;
		/* A held direction must not also pan/zoom the page or fire a
		   long-press selection while the rAF loop is driving movement. */
		touch-action: none;
		user-select: none;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.arena-move-pad {
			display: grid;
		}
	}
</style>
