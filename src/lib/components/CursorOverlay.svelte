<script>
	import { cursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { boardId, userId } = $props()
	const cursorStore = $derived(cursor(`board:${boardId}`, { maxAge: 10000 }))
	const cursors = $derived([...$cursorStore].filter(([, { user }]) => user.id !== userId))

	let canvas = $state()
	let raf = 0

	// Cursor arrow path as a reusable Path2D
	const ARROW = new Path2D('M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z')

	function draw() {
		raf = 0
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		if (!ctx) return

		const dpr = window.devicePixelRatio || 1
		const w = canvas.clientWidth
		const h = canvas.clientHeight

		if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
			canvas.width = w * dpr
			canvas.height = h * dpr
		}

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)
		ctx.textBaseline = 'middle'
		ctx.font = '500 11px system-ui, sans-serif'

		for (const [, { user, data }] of cursors) {
			const x = data.x
			const y = data.y

			// Draw arrow
			ctx.save()
			ctx.translate(x, y)
			ctx.fillStyle = user.color
			ctx.fill(ARROW)
			ctx.restore()

			// Draw name label
			const label = user.name
			const textX = x + 16
			const textY = y + 12
			ctx.lineWidth = 3
			ctx.strokeStyle = user.color + 'e0'
			ctx.strokeText(label, textX, textY)
			ctx.fillStyle = '#fff'
			ctx.fillText(label, textX, textY)
		}
	}

	$effect(() => {
		// Subscribe to cursor changes and schedule a repaint
		void cursors
		if (!raf && typeof window !== 'undefined') {
			raf = requestAnimationFrame(draw)
		}
		return () => { if (raf) { cancelAnimationFrame(raf); raf = 0 } }
	})
</script>

<canvas
	bind:this={canvas}
	class="absolute inset-0 w-full h-full pointer-events-none"
	style:z-index="2147483647"
></canvas>
