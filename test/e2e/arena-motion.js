// Measures whether /demos/arena's remote dots move between packets or only
// when one lands. Shared by the arena spec and by anything that has to show
// the measurement can fail.

// Count inbound WebSocket messages from before the page's own scripts run, so
// every frame can be told apart from one a packet landed in.
export async function countWebSocketMessages(page) {
	await page.addInitScript(() => {
		window.__wsMessages = 0
		const Native = window.WebSocket
		window.WebSocket = class extends Native {
			constructor(url, protocols) {
				super(url, protocols)
				this.addEventListener('message', () => { window.__wsMessages++ })
			}
		}
	})
}

// Sample every remote dot on each animation frame and total up the frames no
// packet can explain: no message arrived since the previous frame. The smooth
// client draws a packet in the frame it lands in, so a stepping renderer moves
// nothing on those frames; if that ever slipped to one frame late, stepping
// would still move dots on only the minority of quiet frames that follow a
// packet frame. On quiet frames, count per DOT how many of the dots drawn in
// both frames moved. Positions are read against the world's wall rect, so a
// moving camera, which shifts every dot on screen, does not count as the dots
// moving.
//
// Samples for at least minMs and then until wantQuiet quiet frames have
// accumulated or maxMs is up, so a slow machine collects the same evidence
// over a longer window instead of failing on a thin one.
export async function sampleRemoteMotion(page, { minMs = 4_000, maxMs = 12_000, wantQuiet = 60 } = {}) {
	const totals = await page.evaluate((opts) => new Promise((resolve) => {
		const walls = document.querySelector('[data-testid="arena-viewport"] > rect')
		const last = new Map()
		const sum = { frames: 0, packets: 0, dots: 0, quiet: 0, compared: 0, moved: 0 }
		let seen = window.__wsMessages
		let first = true
		let start = -1
		const tick = (ts) => {
			if (start < 0) start = ts
			const count = window.__wsMessages
			const packets = count - seen
			seen = count
			const ox = Number(walls.getAttribute('x'))
			const oy = Number(walls.getAttribute('y'))
			let compared = 0
			let moved = 0
			const dots = document.querySelectorAll('[data-testid="arena-remote"]')
			for (const el of dots) {
				const at = `${Number(el.getAttribute('cx')) - ox},${Number(el.getAttribute('cy')) - oy}`
				if (last.has(el)) {
					compared++
					if (last.get(el) !== at) moved++
				}
				last.set(el, at)
			}
			sum.frames++
			sum.packets += packets
			sum.dots += dots.length
			if (packets === 0 && !first) {
				sum.quiet++
				sum.compared += compared
				sum.moved += moved
			}
			first = false
			const elapsed = ts - start
			if (elapsed < opts.minMs || (sum.quiet < opts.wantQuiet && elapsed < opts.maxMs)) requestAnimationFrame(tick)
			else resolve(sum)
		}
		requestAnimationFrame(tick)
	}), { minMs, maxMs, wantQuiet })
	const meanDots = totals.dots / totals.frames
	const movedShare = totals.compared > 0 ? totals.moved / totals.compared : 0
	const summary = `${totals.frames} frames, ${totals.packets} packets, ${meanDots.toFixed(1)} dots on average; ` +
		`across ${totals.quiet} frames no packet explains, ${totals.moved} of ${totals.compared} dot-frames moved`
	return { ...totals, meanDots, movedShare, summary }
}
