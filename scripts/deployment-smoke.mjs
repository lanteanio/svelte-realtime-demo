import net from 'node:net'
import tls from 'node:tls'
import { createHash, randomBytes } from 'node:crypto'

const baseUrl = new URL(process.argv[2] ?? '')
const timeoutMs = Number.parseInt(process.env.DEPLOY_SMOKE_TIMEOUT_MS ?? '10000', 10)
const mode = process.argv[3]
const skipReadiness = mode === '--skip-readiness'

if (!['http:', 'https:'].includes(baseUrl.protocol) || (mode && !skipReadiness)) {
	throw new Error('usage: node scripts/deployment-smoke.mjs https://your-domain.example [--skip-readiness]')
}

async function fetchWithin(path) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(new URL(path, baseUrl), {
			signal: controller.signal,
			redirect: 'error'
		})
	} finally {
		clearTimeout(timer)
	}
}

if (!skipReadiness) {
	const health = await fetchWithin('/healthz')
	if (health.status !== 200) throw new Error(`/healthz returned ${health.status}`)
}

const page = await fetchWithin('/')
if (page.status !== 200) throw new Error(`/ returned ${page.status}`)

await websocketHandshake(new URL('/ws', baseUrl))
console.log(skipReadiness
	? 'Legacy rollback smoke passed: page and WebSocket upgrade.'
	: 'Deployment smoke passed: readiness, page, and WebSocket upgrade.')

function websocketHandshake(url) {
	return new Promise((resolve, reject) => {
		const secure = url.protocol === 'https:'
		const port = Number(url.port || (secure ? 443 : 80))
		const key = randomBytes(16).toString('base64')
		const expectedAccept = createHash('sha1')
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64')
		let buffer = ''
		let settled = false

		const socket = secure
			? tls.connect({ host: url.hostname, port, servername: url.hostname })
			: net.connect({ host: url.hostname, port })
		const timer = setTimeout(() => finish(new Error('WebSocket handshake timed out')), timeoutMs)

		function finish(error) {
			if (settled) return
			settled = true
			clearTimeout(timer)
			socket.destroy()
			error ? reject(error) : resolve()
		}

		socket.once('error', finish)
		socket.once(secure ? 'secureConnect' : 'connect', () => {
			socket.write([
				`GET ${url.pathname}${url.search} HTTP/1.1`,
				`Host: ${url.host}`,
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Version: 13',
				`Sec-WebSocket-Key: ${key}`,
				'',
				''
			].join('\r\n'))
		})

		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1')
			const end = buffer.indexOf('\r\n\r\n')
			if (end === -1) return

			const [statusLine, ...headers] = buffer.slice(0, end).split('\r\n')
			const accept = headers
				.map((line) => line.split(/:\s*/, 2))
				.find(([name]) => name.toLowerCase() === 'sec-websocket-accept')?.[1]

			if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
				finish(new Error(`WebSocket upgrade returned: ${statusLine}`))
			} else if (accept !== expectedAccept) {
				finish(new Error('WebSocket upgrade returned an invalid Sec-WebSocket-Accept header'))
			} else {
				finish()
			}
		})
	})
}
