import { isAppWebSocket } from './helpers.js'

// Observe the production binary path without changing negotiated capabilities.
// These test-only imports deliberately use the installed adapter's own decoder,
// resolved beside its public client entry, rather than copying the wire format.
const clientEntry = import.meta.resolve('svelte-adapter-uws/client')
const { parseBinaryFrame } = await import(new URL('./runtime/wire.js', clientEntry).href)
const { decodeSmooth, SmoothDecodeDict } = await import(new URL('./plugins/smooth/codec.js', clientEntry).href)

// Keep counts, not an unbounded frame transcript. Explicit remove delivery is
// the oracle: waiting for a small HUD count alone would also accept TTL expiry.
export function watchArena(page) {
	const record = { ownKey: '', updates: new Map(), removes: new Map(), binaryFrames: 0, decodeErrors: 0, snapshotSize: 0 }
	const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
	function read(frame) {
		if (!frame || typeof frame !== 'object') return
		if (Array.isArray(frame)) { for (const item of frame) read(item); return }
		if (typeof frame.you === 'string' && Array.isArray(frame.states)) { record.ownKey = frame.you; record.snapshotSize = frame.states.length }
		if (frame.topic === '__smooth:demos:arena:main') {
			if (frame.event === 'remove') count(record.removes, frame.data?.key)
			if (frame.event === 'update') count(record.updates, frame.data?.key)
			if (frame.event === 'update-batch') {
				for (const item of frame.data?.updates ?? []) count(record.updates, item.key)
			}
		}
		// Sync replies can be nested inside a batched RPC response.
		if (frame.data) read(frame.data)
		if (frame.batch) read(frame.batch)
	}
	page.on('websocket', (ws) => {
		if (!isAppWebSocket(ws)) return
		const topicIds = new Map()
		const dictionary = new SmoothDecodeDict()
		ws.on('framereceived', ({ payload }) => {
			if (typeof payload === 'string') {
				let frame
				try { frame = JSON.parse(payload) } catch { return }
				if (frame.type === 'wire-id') topicIds.set(frame.id, frame.topic)
				read(frame)
				return
			}
			const frame = parseBinaryFrame(payload)
			if (!frame) { record.decodeErrors++; return }
			const topic = topicIds.get(frame.topicId)
			if (!topic?.startsWith('__smooth:')) return
			const decoded = decodeSmooth(frame.payload, dictionary, frame.schemaVersion)
			if (!decoded) { record.decodeErrors++; return }
			if (topic === '__smooth:demos:arena:main') record.binaryFrames++
			read({ topic, ...decoded })
		})
	})
	return record
}

export async function location(page, kind) {
	if (kind === 'visitor') {
		const dot = page.getByTestId('arena-me')
		return { x: Number(await dot.getAttribute('data-x')), y: Number(await dot.getAttribute('data-y')) }
	}
	const match = ((await page.getByTestId('arena-cam').textContent()) ?? '').match(/cam\s+(-?\d+),\s*(-?\d+)/)
	return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: NaN, y: NaN }
}

export async function panTo(page, spot) {
	for (let i = 0; i < 40; i++) {
		const cam = await location(page, 'camera')
		if (Math.abs(cam.x - spot.x) > 80) await page.getByTestId(cam.x < spot.x ? 'arena-pan-right' : 'arena-pan-left').click()
		else if (Math.abs(cam.y - spot.y) > 80) await page.getByTestId(cam.y < spot.y ? 'arena-pan-down' : 'arena-pan-up').click()
		else return
	}
	throw new Error(`camera never reached ${spot.x}, ${spot.y}`)
}

