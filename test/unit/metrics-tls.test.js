import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('metrics scraping verifies TLS before sending credentials and accepts explicit trust', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'metrics-tls-'))
	const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
	const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
	const key = join(directory, 'key.pem')
	const cert = join(directory, 'cert.pem')
	const created = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
		'-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' })
	assert.equal(created.status, 0, created.stderr)
	const requests = []
	const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
		requests.push(request.headers['x-scrape-token'])
		response.end('sample_metric 1\n')
	})
	try {
		await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
		const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port
		const helper = fileURLToPath(new URL('../../scripts/scrape-metrics.sh', import.meta.url)).replaceAll('\\', '/')
		const url = `https://127.0.0.1:${port}/metrics`
		const token = 'synthetic-scrape-token'
		async function scrape(trust) {
			const env = { ...process.env }
			delete env.CURL_CA_BUNDLE
			delete env.SSL_CERT_FILE
			delete env.SSL_CERT_DIR
			delete env.METRICS_CA_BUNDLE
			env.NO_PROXY = '127.0.0.1'
			if (trust) env.METRICS_CA_BUNDLE = cert.replaceAll('\\', '/')
			return new Promise((resolve, reject) => {
				const child = spawn(bash, ['-c', 'source "$1"; scrape_metrics "$2" "$3"', 'scrape', helper, url, token], { env })
				let output = '', error = ''
				child.stdout.on('data', data => { output += data })
				child.stderr.on('data', data => { error += data })
				child.once('error', reject)
				child.once('exit', code => resolve({ code, output, error }))
			})
		}
		const refused = await scrape(false)
		assert.notEqual(refused.code, 0)
		assert.match(refused.error, /metrics scrape failed/)
		assert.ok(!refused.error.includes(token))
		assert.deepEqual(requests, [])
		const trusted = await scrape(true)
		assert.equal(trusted.code, 0, trusted.error)
		assert.equal(trusted.output, 'sample_metric 1\n')
		assert.deepEqual(requests, [token])
	} finally {
		await new Promise(resolve => server.close(resolve))
		await rm(directory, { recursive: true, force: true })
	}
})
