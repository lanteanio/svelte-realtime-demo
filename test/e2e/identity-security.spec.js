import { test, expect } from '@playwright/test'
import { WebSocket } from 'ws'
import { callRpc } from './ws-rpc.js'
import { toWebSocketURL, toHandshakeOrigin } from '../../scripts/test-target.mjs'

function sessionCookie(headers) {
	const values = Array.isArray(headers) ? headers : [headers ?? '']
	const entry = values.find(value => value.startsWith('identity='))
	expect(entry, 'the response issues an opaque identity cookie').toBeTruthy()
	const cookie = entry.split(';', 1)[0]
	expect(cookie).toMatch(/^identity=[A-Za-z0-9_-]{22}$/)
	return cookie
}

async function loadIdentity(request, baseURL, cookie) {
	const response = await request.get(new URL('/__data.json', baseURL).href, { headers: cookie ? { Cookie: cookie } : {} })
	expect(response.status()).toBe(200)
	const payload = await response.json()
	expect(payload.type).toBe('data')
	const layout = payload.nodes[0]
	expect(layout.type).toBe('data')
	// Root layout data uses devalue's reference array. Read the identity's
	// scalar fields without evaluating the server-rendered document.
	const values = layout.data
	expect(Number.isInteger(values[0].identity)).toBe(true)
	const references = values[values[0].identity]
	const identity = Object.fromEntries(Object.entries(references).map(([field, index]) => [field, values[index]]))
	expect(identity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
	return { identity, issuedCookie: response.headers()['set-cookie'] }
}

async function connect(baseURL, cookie, sockets) {
	const address = toWebSocketURL(baseURL)
	const socket = new WebSocket(address, { origin: toHandshakeOrigin(address), headers: { Cookie: cookie }, handshakeTimeout: 10_000 })
	sockets.push(socket)
	await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
	return socket
}

for (const entry of ['page load', 'WebSocket upgrade']) {
	test(`a forged legacy cookie cannot impersonate a visitor through ${entry}`, async ({ request, baseURL }) => {
		const sockets = []
		try {
			const victim = await loadIdentity(request, baseURL)
			const victimCookie = sessionCookie(victim.issuedCookie)
			const owner = await connect(baseURL, victimCookie, sockets)
			await expect(callRpc(owner, 'demos/chaos/myChaosState', [])).resolves.toMatchObject({ id: victim.identity.id })
			const board = await callRpc(owner, 'boards/createBoard', ['Identity isolation'])
			const note = await callRpc(owner, 'boards/notes/createNote', [board.board_id, { content: 'Private undo receipt', x: 100, y: 100, color: '#fef08a' }])
			const receipt = await callRpc(owner, 'boards/notes/deleteNote', [board.board_id, note.note_id])
			const pending = await callRpc(owner, 'boards/notes/pendingNoteDeletions', [board.board_id])
			expect(pending.map(item => item.token)).toEqual([receipt.token])
			const forged = `identity=${encodeURIComponent(JSON.stringify(victim.identity))}`
			let attacker
			let migratedId
			if (entry === 'page load') {
				const migrated = await loadIdentity(request, baseURL, forged)
				const attackerCookie = sessionCookie(migrated.issuedCookie)
				migratedId = migrated.identity.id
				expect(migrated.identity).toMatchObject({ name: victim.identity.name, color: victim.identity.color, org: victim.identity.org })
				expect((await loadIdentity(request, baseURL, attackerCookie)).identity).toEqual(migrated.identity)
				attacker = await connect(baseURL, attackerCookie, sockets)
			} else {
				attacker = await connect(baseURL, forged, sockets)
			}
			// This existing read-only RPC returns ctx.user.id. Observe the actual
			// connection identity without assuming a Set-Cookie on the 101 response.
			const connected = await callRpc(attacker, 'demos/chaos/myChaosState', [])
			expect(connected.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
			expect(connected.id).not.toBe(victim.identity.id)
			if (migratedId) expect(connected.id).toBe(migratedId)
			await expect(callRpc(attacker, 'demos/chaos/myChaosState', [])).resolves.toMatchObject({ id: connected.id })
			expect((await loadIdentity(request, baseURL, victimCookie)).identity).toEqual(victim.identity)
			await expect(callRpc(attacker, 'boards/notes/pendingNoteDeletions', [board.board_id])).resolves.toEqual([])
			await expect(callRpc(attacker, 'boards/notes/undoNoteDeletion', [board.board_id, receipt.token])).rejects.toThrow('CONFLICT')
			await expect(callRpc(owner, 'boards/notes/undoNoteDeletion', [board.board_id, receipt.token])).resolves.toMatchObject({ note_id: note.note_id, content: 'Private undo receipt' })
		} finally {
			for (const socket of sockets) socket.terminate()
		}
	})
}
