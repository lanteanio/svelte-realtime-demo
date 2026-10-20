<!--
	/demos/shooter - lag-compensated hits on a smoothed world.

	Eight targets orbit the range; click to shoot a ray from your dot
	toward the click point. The server resolves each shot against the
	historical world using a click-time estimate from the public server
	clock. The estimate is captured before the slider's artificial wait,
	then passed through shoot's rt option when the delayed send leaves.
	It is not the exact interpolation-frame timestamp.

	The server bounds the requested rewind by its own uplink and
	interpolation measurement, with maxRewindMs 400 as an upper ceiling.
	Holding a shot does not earn a larger allowance. The slider reaches
	2000ms so targets can drift outside the hitbox after that allowance
	is exhausted; a target moving along the ray can still be hit.
-->
<script>
	import MovePad from '$lib/components/MovePad.svelte'
	import { shooter } from '$live/demos/shooter'
	import { apply, RANGE_W, RANGE_H, HITBOX_R, SHOT_MAX_DIST } from '../../../live/demos/shooter.shared.js'

	const STEP = 5

	const view = shooter.smooth({
		apply,
		initial: { x: RANGE_W / 2, y: RANGE_H / 2, hp: 3, score: 0 }
	})
	const pendingShots = new Set()
	$effect(() => () => {
		for (const timer of pendingShots) clearTimeout(timer)
		pendingShots.clear()
		view.destroy()
	})

	// --- Artificial extra latency on YOUR shots (the demo's subject) ---
	//
	// Delay shots only. Movement prediction runs inside view.command and
	// must stay immediate even while a shot waits to be transmitted.
	let lagMs = $state(0)
	let shotsFired = $state(0)

	function scheduleFire(angle) {
		const aimedAt = view.now()
		const send = () => {
			view.shoot({ angle }, { rt: aimedAt })
			shotsFired += 1
			addFlash(angle)
		}
		if (lagMs > 0) {
			const timer = setTimeout(() => {
				pendingShots.delete(timer)
				send()
			}, lagMs)
			pendingShots.add(timer)
		} else send()
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

	// Immediate click receipt, separate from the shot itself: with lag on the
	// slider the muzzle flash honestly waits for the delayed send, which
	// leaves the click with no acknowledgment for up to 2000ms - and a control
	// that feels dead gets clicked again. The ring says "click received, send
	// queued" at the click point the moment it happens; the flash still says
	// "sent" when the send leaves.
	let clickRings = $state([])

	function addClickRing(x, y) {
		const id = ++fxId
		clickRings = [...clickRings, { id, x, y }]
		setTimeout(() => { clickRings = clickRings.filter((r) => r.id !== id) }, 300)
	}

	// Hit events ride the channel, not state: onHit's emitEvent lands here
	// for the shooter and the victim alike. Subscribe before any command.
	// hitsSeen counts the event stream; the score card shows the
	// authoritative counter the server keeps on your entity state.
	let lastHit = $state('')
	let lastRewindMs = $state(/** @type {number | null} */ (null))
	let hitsSeen = $state(0)
	$effect(() => {
		const off = view.onEvent((e) => {
			if (e.type !== 'hit' || e.origin !== 'server') return
			if (e.data?.at) addSpark(e.data.at)
			if (e.data?.by === view.self) {
				lastHit = e.data?.target ?? ''
				lastRewindMs = e.data.rewindMs
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
		addClickRing(px, py)
		const angle = Math.atan2(py - view.local.y, px - view.local.x)
		scheduleFire(angle)
	}

	// Keyboard fire path: Space/Enter shoots toward the nearest rendered
	// target, so the demo's single success action does not require a
	// pointing device.
	function fireAtNearest() {
		let best = null
		let bestD = Infinity
		for (const [, s] of targets) {
			const dx = s.x - view.local.x
			const dy = s.y - view.local.y
			const d = dx * dx + dy * dy
			if (d < bestD) {
				bestD = d
				best = s
			}
		}
		if (!best) return
		addClickRing(best.x, best.y)
		scheduleFire(Math.atan2(best.y - view.local.y, best.x - view.local.x))
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

	// Space and Enter belong to whatever control has focus: Enter activates a
	// link, Space presses a button, either types into an editor. Naming the
	// element types to skip is what shipped first, and it named buttons but not
	// anchors - so a focused link stopped navigating, because this handler ate
	// the key and called preventDefault on it. That traded one keyboard gap for
	// another. Asking the inverse question keeps a control added to this page
	// later from silently losing its keys.
	function ownsItsOwnKeys(target) {
		if (!(target instanceof Element)) return false
		if (target instanceof HTMLElement && target.isContentEditable) return true
		return !!target.closest(
			'a[href], button, input, select, textarea, summary,'
			+ ' [contenteditable]:not([contenteditable="false"]),'
			+ ' [tabindex]:not([tabindex="-1"])'
		)
	}

	function onKeydown(e) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
		if (e.key === ' ' || e.key === 'Enter') {
			if (ownsItsOwnKeys(e.target)) return
			if (e.repeat) return
			fireAtNearest()
			e.preventDefault()
			return
		}
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
			if (dx !== 0 || dy !== 0) view.command({ type: 'move', dx, dy })
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
		<h1 class="page-title mt-2">Shooter: lag-compensated hits</h1>
		<p class="text-sm opacity-70 mt-1">
			Click inside the arena to shoot. Each shot keeps a click-time estimate
			from the server clock, even when the latency slider delays its send.
			The server tests the ray against historical positions
			(<code>live.smooth(&#123; hitTest &#125;)</code>), bounded by the
			uplink and interpolation allowance it measures itself, up to
			<code>maxRewindMs: 400</code>. Raising the slider asks for an older
			world; it does not increase that allowance. The score card reports
			the rewind the server actually used for your last hit.
		</p>
	</header>

	<!-- An auto track sizes to the SVG's 300px replaced-element fallback
	     (the svg has only a viewBox), so w-full/max-w never engage; fr
	     tracks give the arena a definite width to fill. -->
	<div class="grid gap-4 @5xl:grid-cols-[3fr_2fr]">
		<!-- self-start: the arena card wraps its content instead of stretching
		     to the taller column and framing the game in dead space. -->
		<div class="card bg-base-200 self-start" data-testid="sh-arena-card">
			<div class="card-body p-3 space-y-2" data-testid="sh-arena-card-body">
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
					{#each clickRings as ring (ring.id)}
						<circle cx={ring.x} cy={ring.y} r="10" class="fill-none stroke-info" stroke-width="1.5" opacity="0.7" data-testid="sh-click-ring" />
					{/each}
					<circle
						cx={view.local.x} cy={view.local.y} r="9"
						class="fill-primary stroke-primary-content" stroke-width="2"
						data-testid="sh-me"
						data-x={Math.round(view.local.x)}
						data-y={Math.round(view.local.y)}
					/>
					<!-- The shot ray originates at your dot, so aiming requires
					     knowing which dot is yours before the first click; flips
					     below the dot near the top edge so it never clips out of
					     the viewBox. -->
					<text
						x={view.local.x}
						y={view.local.y < 26 ? view.local.y + 22 : view.local.y - 14}
						text-anchor="middle"
						class="fill-base-content font-mono select-none pointer-events-none"
						font-size="10"
						opacity="0.75"
						data-testid="sh-you-label"
					>you</text>
				</svg>
				<p class="text-xs opacity-50">WASD / arrows to move; click the arena or press Space to shoot.</p>
				<MovePad
					idPrefix="sh-move"
					onpress={(direction) => held.add(direction)}
					onrelease={(direction) => held.delete(direction)}
				/>
			</div>
		</div>

		<div class="space-y-4" data-testid="sh-side-column">
			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-1">
					<h2 class="section-title card-title">Score</h2>
					<p class="font-mono text-2xl" data-testid="sh-score">{view.local.score ?? 0}</p>
					<p class="text-xs opacity-60">
						Authoritative: <code>onHit</code> credits the shooter through
						the shared <code>apply</code> (<code>ctx.applyTo</code>), so
						this number is the server's answer, not a local guess.
					</p>
					<!-- Victims exist too: onHit damages whoever is hit, and your
					     own hp is the visible half of that story in a shared room. -->
					<p class="font-mono text-xs opacity-60" data-testid="sh-hp">hp: {view.local.hp ?? 3}</p>
					<p class="font-mono text-xs opacity-60" data-testid="sh-shots">shots fired: {shotsFired}</p>
					<p class="font-mono text-xs opacity-60" data-testid="sh-hits">hit events seen: {hitsSeen}</p>
					<p class="font-mono text-xs opacity-60" data-testid="sh-last-rewind">last hit rewind: {lastRewindMs === null ? 'waiting for a hit' : `${Math.round(lastRewindMs)}ms`}</p>
					{#if lastHit}
						<p class="font-mono text-xs opacity-60" data-testid="sh-last-hit">last hit: {lastHit}</p>
					{/if}
				</div>
			</div>

			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-1">
					<h2 class="section-title card-title">Extra latency: {lagMs}ms</h2>
					<!-- The mark is the maximum allowance, not a promise that every
					     shot below it is covered: the measured allowance can be lower. -->
					<input
						type="range"
						class="range range-sm"
						min="0" max="2000" step="50"
						bind:value={lagMs}
						data-testid="sh-lag"
					/>
					<div class="relative h-4 text-[10px] font-mono opacity-60" aria-hidden="true">
						<span class="absolute left-0">0</span>
						<span class="absolute -translate-x-1/2" style="left: 20%" data-testid="sh-lag-cap-mark">400 = cap</span>
						<span class="absolute right-0">2000</span>
					</div>
					<p class="text-xs opacity-60">
						Holds your shots before sending; movement stays immediate.
						The click ring appears at once and the muzzle flash appears
						when the shot leaves. Its timestamp stays at click time.
						The server's measured allowance may be below the 400ms cap,
						so even a shorter hold is not guaranteed a hit. Past 400ms,
						some of the wait is always uncovered. Try 2000ms: targets
						can drift outside your ray, though ones moving along it can
						still be hit. Holding a shot does not earn extra rewind.
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
			The page captures <code>view.now()</code>, the estimated server clock,
			when you aim and passes it as <code>view.shoot(cmd, &#123; rt &#125;)</code>
			after the delay. This is a click-time estimate, not the exact timestamp
			of the interpolated frame you see.
		</p>
		<p>
			<code>hitTest</code>: ray from your state toward
			<code>cmd.angle</code>, circle hitbox r=18,
			<code>maxRewindMs: 400</code>. <code>onHit</code> applies
			<code>&#123;type:'damage'&#125;</code> to the victim and
			<code>&#123;type:'score'&#125;</code> to the shooter via
			<code>ctx.applyTo</code>, then <code>ctx.emitEvent('hit')</code>
			drives the spark and reports <code>info.rewindMs</code>, the owner's
			applied rewind duration. The score card shows that measurement for
			your last hit; a miss does not produce an <code>onHit</code> event.
			A shot is fire-and-forget
			(<code>view.shoot</code>) - never predicted, its outcome is an
			event, not a reconciliation.
			See <a class="link" href="https://github.com/lanteanio/svelte-realtime-demo/blob/main/src/live/demos/shooter.js">shooter.js</a>.
		</p>
	</aside>
</div>
