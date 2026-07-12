<!--
	/demos/shooter - lag-compensated hits on a smoothed world.

	Eight targets orbit the range; click to shoot a ray from your dot
	toward the click point. The server resolves each shot against the
	world AS YOU RENDERED IT: the shot carries a render-time stamp, the
	server rewinds every candidate to that instant (bounded by its own
	uplink + interpolation measurement, capped at maxRewindMs 400) and
	tests the ray there.

	The wow: drag the latency slider up to 400ms. Your command and shoot
	sends now leave late (a setTimeout wrapper - a stand-in for a slow
	uplink), yet shots aimed at where you SEE a target still land: the
	rewind resolves against the rendered scene, not the server's present.
	Fairness holds because both rewind legs are server-measured - a client
	can inflate its latency only by genuinely lagging - and the whole
	window is capped by maxRewindMs.
-->
<script>
	import { shooter } from '$live/demos/shooter'
	import { apply, RANGE_W, RANGE_H, HITBOX_R, SHOT_MAX_DIST } from '../../../live/demos/shooter.shared.js'

	const STEP = 5

	const view = shooter.smooth({
		apply,
		initial: { x: RANGE_W / 2, y: RANGE_H / 2, hp: 3, score: 0 }
	})
	$effect(() => () => view.destroy())

	// --- Artificial extra latency on YOUR sends (the demo's subject) ---
	let lagMs = $state(0)
	let shotsFired = $state(0)

	function sendCommand(cmd) {
		if (lagMs > 0) setTimeout(() => view.command(cmd), lagMs)
		else view.command(cmd)
	}

	function scheduleFire(angle) {
		const send = () => {
			view.shoot({ angle })
			shotsFired += 1
			addFlash(angle)
		}
		if (lagMs > 0) setTimeout(send, lagMs)
		else send()
	}

	// --- One-shot visuals: muzzle flash lines and hit sparks ---
	let flashes = $state([])
	let sparks = $state([])
	let fxId = 0

	function addFlash(angle) {
		const id = ++fxId
		const x1 = view.local.x
		const y1 = view.local.y
		flashes = [...flashes, {
			id, x1, y1,
			x2: x1 + Math.cos(angle) * SHOT_MAX_DIST,
			y2: y1 + Math.sin(angle) * SHOT_MAX_DIST
		}]
		setTimeout(() => { flashes = flashes.filter((f) => f.id !== id) }, 150)
	}

	function addSpark(at) {
		const id = ++fxId
		sparks = [...sparks, { id, x: at.x, y: at.y }]
		setTimeout(() => { sparks = sparks.filter((s) => s.id !== id) }, 400)
	}

	// Hit events ride the channel, not state: onHit's emitEvent lands here
	// for the shooter and the victim alike. Subscribe before any command.
	// hitsSeen counts the event stream; the score card shows the
	// authoritative counter the server keeps on your entity state.
	let lastHit = $state('')
	let hitsSeen = $state(0)
	$effect(() => {
		const off = view.onEvent((e) => {
			if (e.type !== 'hit' || e.origin !== 'server') return
			if (e.data?.at) addSpark(e.data.at)
			if (e.data?.by === view.self) {
				lastHit = e.data?.target ?? ''
				hitsSeen += 1
			}
		})
		return () => off()
	})

	// --- Click-to-shoot: angle from your dot to the click point ---
	function onRangeClick(e) {
		const rect = e.currentTarget.getBoundingClientRect()
		const px = (e.clientX - rect.left) * (RANGE_W / rect.width)
		const py = (e.clientY - rect.top) * (RANGE_H / rect.height)
		const angle = Math.atan2(py - view.local.y, px - view.local.x)
		scheduleFire(angle)
	}

	// --- Movement: held keys drained by a ~30Hz rAF-gated loop ---
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
			if (held.size === 0) return
			let dx = 0
			let dy = 0
			if (held.has('left')) dx -= STEP
			if (held.has('right')) dx += STEP
			if (held.has('up')) dy -= STEP
			if (held.has('down')) dy += STEP
			if (dx !== 0 || dy !== 0) sendCommand({ type: 'move', dx, dy })
		}
		raf = requestAnimationFrame(loop)
		return () => cancelAnimationFrame(raf)
	})

	const targets = $derived([...view.remote].filter(([, s]) => s.npc))
	const others = $derived([...view.remote].filter(([, s]) => !s.npc))
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<div class="max-w-5xl mx-auto p-8 space-y-4">
	<header>
		<h1 class="text-2xl font-bold mt-2">Shooter: lag-compensated hits</h1>
		<p class="text-sm opacity-70 mt-1">
			Click the range to shoot. The server rewinds every candidate to the
			instant you rendered it and tests the ray there
			(<code>live.smooth(&#123; hitTest &#125;)</code>) - so a shot that
			landed on your screen lands on the server. Crank the latency slider:
			delayed sends still hit where you saw the target, because the rewind
			window is server-measured (uplink + interpolation) and capped by
			<code>maxRewindMs: 400</code>.
		</p>
	</header>

	<div class="grid gap-4 lg:grid-cols-[auto_1fr]">
		<div class="card bg-base-200">
			<div class="card-body p-3 space-y-2">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<svg
					viewBox="0 0 {RANGE_W} {RANGE_H}"
					class="w-full max-w-[640px] bg-base-300 rounded-box select-none cursor-crosshair"
					role="img"
					onclick={onRangeClick}
					data-testid="sh-range"
				>
					<rect x="1" y="1" width={RANGE_W - 2} height={RANGE_H - 2} class="fill-none stroke-base-content/20" stroke-width="2" />
					{#each flashes as f (f.id)}
						<line x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} class="stroke-warning" stroke-width="1.5" opacity="0.8" />
					{/each}
					{#each targets as [key, s] (key)}
						<circle
							cx={s.x} cy={s.y} r={HITBOX_R}
							class="fill-secondary stroke-secondary-content/40"
							stroke-width={s.hp}
							opacity={0.4 + 0.2 * s.hp}
							data-testid="sh-target"
							data-key={key}
						/>
					{/each}
					{#each others as [key, s] (key)}
						<circle cx={s.x} cy={s.y} r="9" class="fill-accent" data-testid="sh-other" data-key={key} />
					{/each}
					{#each sparks as sp (sp.id)}
						<circle cx={sp.x} cy={sp.y} r="6" class="fill-warning" opacity="0.9" />
						<circle cx={sp.x} cy={sp.y} r="12" class="fill-none stroke-warning" stroke-width="2" opacity="0.6" />
					{/each}
					<circle
						cx={view.local.x} cy={view.local.y} r="9"
						class="fill-primary stroke-primary-content" stroke-width="2"
						data-testid="sh-me"
						data-x={Math.round(view.local.x)}
						data-y={Math.round(view.local.y)}
					/>
				</svg>
				<p class="text-xs opacity-50">WASD / arrows to move, click to shoot.</p>
			</div>
		</div>

		<div class="space-y-4">
			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-1">
					<h2 class="card-title text-sm">Score</h2>
					<p class="font-mono text-2xl" data-testid="sh-score">{view.local.score ?? 0}</p>
					<p class="text-xs opacity-60">
						Authoritative: <code>onHit</code> credits the shooter through
						the shared <code>apply</code> (<code>ctx.applyTo</code>), so
						this number is the server's answer, not a local guess.
					</p>
					<p class="font-mono text-xs opacity-60" data-testid="sh-shots">shots fired: {shotsFired}</p>
					<p class="font-mono text-xs opacity-60" data-testid="sh-hits">hit events seen: {hitsSeen}</p>
					{#if lastHit}
						<p class="font-mono text-xs opacity-60" data-testid="sh-last-hit">last hit: {lastHit}</p>
					{/if}
				</div>
			</div>

			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-1">
					<h2 class="card-title text-sm">Extra latency: {lagMs}ms</h2>
					<input
						type="range"
						class="range range-sm"
						min="0" max="400" step="50"
						bind:value={lagMs}
						data-testid="sh-lag"
					/>
					<p class="text-xs opacity-60">
						Delays your command/shoot sends with a
						<code>setTimeout</code> wrapper. The shot fires (and the
						muzzle flash draws) when the send actually leaves; the
						rewind then resolves it against the scene as rendered at
						that instant. Targets orbit slowly enough that a shot aimed
						at a rendered target stays inside its hitbox across the
						whole slider range.
					</p>
				</div>
			</div>
		</div>
	</div>

	<aside class="text-xs opacity-50 leading-relaxed space-y-2">
		<p>
			Server: <code>live.smooth()</code> on <code>demos:shooter:range</code>
			with the pure shared <code>apply</code> (shooter.shared.js),
			<code>onTick</code> orbiting 8 NPC targets as a pure function of the
			tick stamp, and <code>interest</code> covering the whole range -
			declared because <code>hitTest</code> requires it: the shooter's
			replicated set is the candidate-security gate.
		</p>
		<p>
			<code>hitTest</code>: ray from your state toward
			<code>cmd.angle</code>, circle hitbox r=18,
			<code>maxRewindMs: 400</code>. <code>onHit</code> applies
			<code>&#123;type:'damage'&#125;</code> to the victim and
			<code>&#123;type:'score'&#125;</code> to the shooter via
			<code>ctx.applyTo</code>, then <code>ctx.emitEvent('hit')</code>
			drives the spark you see. A shot is fire-and-forget
			(<code>view.shoot</code>) - never predicted, its outcome is an
			event, not a reconciliation.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/shooter.js">shooter.js</a>.
		</p>
	</aside>
</div>
