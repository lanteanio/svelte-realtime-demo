<script>
	import { cursor } from 'svelte-adapter-uws/plugins/cursor/client'

	let { boardId, userId } = $props()
	const cursorStore = $derived(cursor(`board:${boardId}`, { maxAge: 10000 }))
	const cursors = $derived([...$cursorStore].filter(([, { user }]) => user.id !== userId))

	let canvas = $state()
	let raf = 0

	const ARROW = new Path2D('M0,0 L0,16 L4,12 L8,18 L10,17 L6,11 L12,11 Z')

	// Pre-rendered label cache: "name|color" -> { canvas, width, height }
	const labelCache = new Map()

	function getLabel(name, color) {
		const cacheKey = name + '|' + color
		let cached = labelCache.get(cacheKey)
		if (cached) return cached

		// Evict oldest entries if cache gets too large
		if (labelCache.size > 2000) {
			const first = labelCache.keys().next().value
			labelCache.delete(first)
		}

		const dpr = window.devicePixelRatio || 1
		const offscreen = document.createElement('canvas')
		const ctx = offscreen.getContext('2d')

		ctx.font = '500 11px system-ui, sans-serif'
		const metrics = ctx.measureText(name)
		const textW = Math.ceil(metrics.width)
		const pad = 4
		const w = textW + pad * 2
		const h = 16

		offscreen.width = w * dpr
		offscreen.height = h * dpr
		ctx.scale(dpr, dpr)

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

		for (const [, { user, data }] of cursors) {
			// Arrow
			ctx.save()
			ctx.translate(data.x, data.y)
			ctx.fillStyle = user.color
			ctx.fill(ARROW)
			ctx.restore()

			// Cached label bitmap
			const label = getLabel(user.name, user.color)
			ctx.drawImage(label.canvas, data.x + 14, data.y + 4, label.width, label.height)
		}
	}

	$effect(() => {
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
