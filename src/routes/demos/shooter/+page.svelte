<!--
	/demos/shooter - lag-compensated hits on a smoothed world.

	Eight targets orbit the range; click to shoot a ray from your dot
	toward the click point. The server resolves each shot against the
	world AS YOU RENDERED IT: the shot carries a render-time stamp, the
	server rewinds every candidate to that instant (bounded by its own
	uplink + interpolation measurement, capped at maxRewindMs 400) and
	tests the ray there.

	The compensation covers the legs the server measures itself, your real
	uplink and interpolation, and nothing else: a shot's render-time is
	stamped inside shoot() when the send leaves, so the latency slider's
	setTimeout ages your aim instead of widening the rewind. Shots still
	land through most of the slider's travel, but that is the orbit speeds
	being slow enough to keep the drift inside the hitbox (see orbitFor in
	shooter.js), NOT the rewind absorbing the wait. Fairness holds for the
	same reason the slider cannot cheat: a client can inflate its measured
	latency only by genuinely lagging, and the window is capped by
	maxRewindMs.
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
	$effect(() => () => view.destroy())

	// --- Artificial extra latency on YOUR shots (the demo's subject) ---
	//
	// Shots ONLY, never movement. `view.command` is where the local
	// prediction runs - the dot moves on the same frame the key is down -
	// so wrapping it in the invented delay lags the INPUT, not the send:
	// at the slider's top the player's own dot trailed every keypress by
	// 600ms, which reads as broken controls rather than as simulated
	// latency. The channel offers no way to predict now and transmit
	// later, and the slider's subject never needed one: the fairness
	// story it exists for - the rewind measured from when the send
	// leaves, aim ageing while a shot waits - is entirely about shots.
	let lagMs = $state(0)
	let shotsFired = $state(0)

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

	// Immediate click receipt, separate from the shot itself: with lag on the
	// slider the muzzle flash honestly waits for the delayed send, which
	// leaves the click with no acknowledgment for up to 600ms - and a control
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
		<h1 class="text-2xl font-bold mt-2">Shooter: lag-compensated hits</h1>
		<p class="text-sm opacity-70 mt-1">
			Click inside the arena to shoot. The server rewinds every candidate to
			the instant you rendered it and tests the ray there
			(<code>live.smooth(&#123; hitTest &#125;)</code>) - so a shot that
			landed on your screen lands on the server. The window it covers is the
			one it measured itself - your real uplink and interpolation - capped by
			<code>maxRewindMs: 400</code>. Crank the latency slider and the
			compensation does not follow it: a shot is stamped when its send
			leaves, so the wait ages your aim rather than widening the rewind.
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
					<h2 class="card-title text-sm">Score</h2>
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
					{#if lastHit}
						<p class="font-mono text-xs opacity-60" data-testid="sh-last-hit">last hit: {lastHit}</p>
					{/if}
				</div>
			</div>

			<div class="card bg-base-100 border border-base-300">
				<div class="card-body py-3 space-y-1">
					<h2 class="card-title text-sm">Extra latency: {lagMs}ms</h2>
					<!-- The mark labels what maxRewindMs IS; it is not a threshold in
					     this slider's behaviour, and the caption must not imply one.
					     The transport stamps a shot's render-time inside shoot(), at
					     send time, so a delay invented here never enters the server's
					     rewind age and the cap cannot be crossed from the app side at
					     all. Making it crossable needs an app-supplied render stamp
					     the public API does not expose. -->
					<input
						type="range"
						class="range range-sm"
						min="0" max="600" step="50"
						bind:value={lagMs}
						data-testid="sh-lag"
					/>
					<div class="relative h-4 text-[10px] font-mono opacity-60" aria-hidden="true">
						<span class="absolute left-0">0</span>
						<span class="absolute -translate-x-1/2" style="left: 66.67%" data-testid="sh-lag-cap-mark">400 = cap</span>
						<span class="absolute right-0">600</span>
					</div>
					<p class="text-xs opacity-60">
						Delays your shots with a
						<code>setTimeout</code> wrapper - movement stays predicted
						and immediate, so your own dot never lags your keys. The shot
						fires (and the muzzle flash draws) when the send actually
						leaves, and the
						render-time it carries is stamped at that moment - so the
						server rewinds to when the send left, not to when you
						clicked. Your aim keeps ageing during the wait while the
						compensation does not grow to match, so aimed shots start
						to miss as you drag this up. That is the honest half of
						the fairness rule: the rewind is measured from your real
						uplink and interpolation, and a delay you invent locally
						is not latency you earned.
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
