<!--
	CursorOverlay -- renders all other users' cursors on the board.

	Uses Canvas 2D instead of SVG for performance. With 1000 cursors,
	SVG requires 1000 DOM nodes that Svelte diffs every frame. Canvas
	draws all 1000 in a single requestAnimationFrame callback with
	zero DOM overhead.

	Each user's name label is pre-rendered to an offscreen canvas once
	(text shaping is expensive). On each frame, we just blit the cached
	bitmaps with drawImage() -- about 2-5ms for 1000 cursors vs ~35ms
	for live strokeText/fillText.

	The cursor store has maxAge: 10000 (10 seconds). If a cursor hasn't
	received an update in 10 seconds, it's automatically removed. This
	handles the case where a user disconnects and the server fails to
	broadcast a remove event.
-->
<script>
	import { cursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { boardId, userId } = $props()

	// Subscribe to cursor positions. maxAge auto-removes stale entries.
	const cursorStore = $derived(cursor(`board:${boardId}`, { maxAge: 10000 }))

	// Filter out our own cursor -- we don't need to see ourselves.
	const cursors = $derived([...$cursorStore].filter(([, { user }]) => user.id !== userId))

	let canvas = $state()
	let raf = 0

	// The cursor arrow shape, parsed once as a reusable Path2D.
	// This is the classic pointer arrow you see in Figma/Google Docs.
	const ARROW = new Path2D('M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z')

	// --- Label bitmap cache ---
	// Rendering text on canvas is slow (font shaping, glyph rasterization).
	// We render each unique "name + color" combo to an offscreen canvas once,
	// then drawImage() the cached bitmap every frame. This turns a ~35ms
	// per-frame cost into ~3ms.
	const labelCache = new Map()

	function getLabel(name, color) {
		const cacheKey = name + '|' + color
		let cached = labelCache.get(cacheKey)
		if (cached) return cached

		// FIFO eviction to prevent unbounded growth
		if (labelCache.size > 2000) {
			const first = labelCache.keys().next().value
			labelCache.delete(first)
		}

		// Create an offscreen canvas sized to fit this specific name
		const dpr = window.devicePixelRatio || 1
		const offscreen = document.createElement('canvas')
		const ctx = offscreen.getContext('2d')

		ctx.font = '500 11px system-ui, sans-serif'
		const metrics = ctx.measureText(name)
		const textW = Math.ceil(metrics.width)
		const pad = 4
		const w = textW + pad * 2
		const h = 16

		// Scale for retina -- draw at 2x, display at 1x
		offscreen.width = w * dpr
		offscreen.height = h * dpr
		ctx.scale(dpr, dpr)

		// Draw the label: colored stroke outline + white fill
		ctx.font = '500 11px system-ui, sans-serif'
		ctx.textBaseline = 'middle'
		ctx.lineWidth = 3
		ctx.strokeStyle = color + 'e0'
		ctx.strokeText(name, pad, h / 2)
		ctx.fillStyle = '#fff'
		ctx.fillText(name, pad, h / 2)

		cached = { canvas: offscreen, width: w, height: h }
		labelCache.set(cacheKey, cached)
		return cached
	}

	/** Main draw loop -- called once per animation frame when cursors change. */
	function draw() {
		raf = 0
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		if (!ctx) return

		// Handle DPR scaling (retina displays)
		const dpr = window.devicePixelRatio || 1
		const w = canvas.clientWidth
		const h = canvas.clientHeight

		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr
			canvas.height = h * dpr
		}

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)

		for (const [, { user, data }] of cursors) {
			// Draw the colored arrow at the cursor position
			ctx.save()
			ctx.translate(data.x, data.y)
			ctx.fillStyle = user.color
			ctx.fill(ARROW)
			ctx.restore()

			// Blit the pre-rendered name label
			const label = getLabel(user.name, user.color)
			ctx.drawImage(label.canvas, data.x + 14, data.y + 4, label.width, label.height)
		}
	}

	// Schedule a repaint whenever the cursor data changes.
	// Only one rAF is scheduled at a time -- if cursors update faster
	// than the screen refreshes, intermediate states are skipped.
	$effect(() => {
		void cursors
		if (!raf && typeof window !== 'undefined') {
			raf = requestAnimationFrame(draw)
		}
		return () => { if (raf) { cancelAnimationFrame(raf); raf = 0 } }
	})
</script>

<!-- pointer-events-none: clicks pass through to the notes/canvas below -->
<canvas
	bind:this={canvas}
	class="absolute inset-0 w-full h-full pointer-events-none"
	style:z-index="2147483647"
></canvas>
