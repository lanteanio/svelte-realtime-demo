<!--
	Touch movement pad shared by the game demos (arena, shooter).

	Renders nothing on fine-pointer desktops; on coarse pointers or narrow
	viewports it shows a four-way pad whose buttons feed the caller's
	held-direction set through onpress/onrelease. Continuous travel while
	pressed (and diagonals from two held buttons) comes from the caller's
	rAF drain loop - a per-tap command would move one step per tap and need
	hundreds of taps to cross a world.

	idPrefix keeps each page's testids stable: idPrefix="arena-move" yields
	data-testid="arena-move-pad" and "arena-move-up" ... "arena-move-right".
-->
<script>
	let { idPrefix, onpress, onrelease, label = 'Touch controls' } = $props()

	const PAD_KEYS = [
		{ dir: 'up', label: 'Move up', glyph: '↑' },
		{ dir: 'left', label: 'Move left', glyph: '←' },
		{ dir: 'down', label: 'Move down', glyph: '↓' },
		{ dir: 'right', label: 'Move right', glyph: '→' }
	]

	function press(e, direction) {
		e.preventDefault()
		// Capture is best-effort: it keeps the release event on the button
		// when a finger slides off, but setPointerCapture THROWS for a
		// pointerId with no active pointer (synthetic events, some stale
		// cancel paths) - and a throw here would swallow the onpress below.
		try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* no active pointer */ }
		onpress(direction)
	}
</script>

<div class="move-pad" role="group" aria-labelledby="{idPrefix}-label" data-testid="{idPrefix}-pad">
	<span class="move-label" id="{idPrefix}-label">{label}</span>
	{#each PAD_KEYS as pad (pad.dir)}
		<button
			type="button"
			class="btn btn-sm btn-square move-{pad.dir}"
			aria-label={pad.label}
			data-testid="{idPrefix}-{pad.dir}"
			onpointerdown={(e) => press(e, pad.dir)}
			onpointerup={() => onrelease(pad.dir)}
			onpointercancel={() => onrelease(pad.dir)}
			onpointerleave={() => onrelease(pad.dir)}
		>{pad.glyph}</button>
	{/each}
</div>

<style>
	.move-pad {
		display: none;
		grid-template-columns: repeat(3, 2.75rem);
		gap: 0.375rem;
		justify-content: center;
	}

	.move-label {
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
	.move-up    { grid-area: 2 / 2; }
	.move-left  { grid-area: 3 / 1; }
	.move-down  { grid-area: 3 / 2; }
	.move-right { grid-area: 3 / 3; }

	.move-pad .btn {
		width: 2.75rem;
		height: 2.75rem;
		min-height: 2.75rem;
		/* A held direction must not also pan/zoom the page or fire a
		   long-press selection while the rAF loop is driving movement. */
		touch-action: none;
		user-select: none;
	}

	@media (max-width: 767px), (pointer: coarse) {
		.move-pad {
			display: grid;
		}
	}
</style>
