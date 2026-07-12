import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const smokeScript = fileURLToPath(new URL('../../scripts/deployment-smoke.mjs', import.meta.url))

test('legacy rollback smoke skips only readiness and still requires page plus WebSocket', async () => {
	const server = http.createServer((request, response) => {
		if (request.url === '/') {
			response.writeHead(200).end('ok')
			return
		}
		response.writeHead(404).end('missing')
	})
	server.on('upgrade', (request, socket) => {
		assert.equal(request.url, '/ws')
		const accept = createHash('sha1')
			.update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64')
		socket.end([
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${accept}`,
			'',
			''
		].join('\r\n'))
	})

	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen({ port: 0, host: '127.0.0.1' }, () => resolve())
	})

	try {
		const address = server.address()
		assert.ok(address && typeof address !== 'string')
		const url = `http://127.0.0.1:${address.port}`

		await assert.rejects(
			execFileAsync(process.execPath, [smokeScript, url]),
			(error) => {
				const stderr = error && typeof error === 'object' && 'stderr' in error
					? error.stderr
					: undefined
				return typeof stderr === 'string' && stderr.includes('/healthz returned 404')
			}
		)

		const result = await execFileAsync(process.execPath, [smokeScript, url, '--skip-readiness'])
		assert.match(result.stdout, /Legacy rollback smoke passed/)
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
	}
})
