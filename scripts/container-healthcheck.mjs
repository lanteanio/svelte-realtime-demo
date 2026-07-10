import http from 'node:http'
import https from 'node:https'

const port = Number.parseInt(process.env.PORT ?? '443', 10)
const origin = new URL(process.env.ORIGIN ?? `https://127.0.0.1:${port}`)
const socketPath = process.env.LOCAL_HEALTH_SOCKET

// Prefer the container-local Unix socket. With host networking and
// SO_REUSEPORT, 127.0.0.1:443 could otherwise be answered by a healthy sibling
// and falsely certify this container. The HTTPS branch remains a useful
// fallback for running the script outside the production image.
const request = socketPath
	? http.request({ socketPath, path: '/healthz', method: 'GET', timeout: 3_000 })
	: https.request({
			host: '127.0.0.1',
			port,
			path: '/healthz',
			method: 'GET',
			headers: { host: origin.host },
			rejectUnauthorized: false,
			timeout: 3_000
		})

request.once('response', (response) => {
	response.resume()
	process.exitCode = response.statusCode === 200 ? 0 : 1
})
request.once('timeout', () => request.destroy(new Error('health probe timed out')))
request.once('error', (error) => {
	console.error(`[healthcheck] ${error.message}`)
	process.exitCode = 1
})
request.end()
