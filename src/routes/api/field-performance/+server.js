import { error } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { fieldPerformanceEnabled, readFieldPerformanceDay, recordFieldPerformanceSample } from '$lib/server/field-performance'

function enabled() {
	if (!fieldPerformanceEnabled()) error(404, 'Not found')
}

export async function POST({ request }) {
	enabled()
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') error(415, 'Expected JSON')
	if (Number(request.headers.get('content-length')) > 16_384) error(413, 'Sample too large')
	let input
	try {
		const text = await request.text()
		if (text.length > 16_384) error(413, 'Sample too large')
		input = JSON.parse(text)
		await recordFieldPerformanceSample(redis.redis, input)
	} catch (cause) {
		if (cause?.status) throw cause
		error(400, 'Invalid sample')
	}
	return new Response(null, { status: 202 })
}

export async function GET({ request, url }) {
	enabled()
	const expected = process.env.METRICS_SCRAPE_TOKEN
	if (expected && request.headers.get('x-scrape-token') !== expected) error(401, 'Unauthorized')
	const day = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)
	try {
		return Response.json(await readFieldPerformanceDay(redis.redis, day))
	} catch {
		error(400, 'Invalid date')
	}
}
