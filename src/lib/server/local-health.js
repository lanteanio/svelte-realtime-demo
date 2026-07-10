/**
 * Process-local health listener for Docker.
 *
 * Production replicas share host:443 with SO_REUSEPORT, so an HTTPS probe to
 * 127.0.0.1 can be answered by a healthy sibling. A Unix socket lives in the
 * container filesystem and proves this exact Node process is responsive.
 */

import http from 'node:http'
import { rm } from 'node:fs/promises'
import { checkReadiness } from '$lib/server/readiness'

const socketPath = process.env.LOCAL_HEALTH_SOCKET
let server = null

export async function startLocalHealthServer() {
	if (!socketPath || server) return
	await rm(socketPath, { force: true })

	server = http.createServer(async (request, response) => {
		if (request.url !== '/healthz') {
			response.writeHead(404).end()
			return
		}

		const readiness = await checkReadiness()
		const body = JSON.stringify(readiness)
		response.writeHead(readiness.status === 'ok' ? 200 : 503, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(body)
		})
		response.end(body)
	})

	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server = null
			reject(error)
		}
		server.once('error', onError)
		server.listen(socketPath, () => {
			server.off('error', onError)
			resolve()
		})
	})
}

export async function stopLocalHealthServer() {
	const current = server
	server = null
	if (current) {
		await new Promise((resolve) => current.close(() => resolve()))
	}
	if (socketPath) await rm(socketPath, { force: true }).catch(() => {})
}
