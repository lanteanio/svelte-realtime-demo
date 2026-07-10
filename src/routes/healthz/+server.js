import { json } from '@sveltejs/kit'
import { checkReadiness } from '$lib/server/readiness'

export async function GET() {
	const readiness = await checkReadiness()
	return json(readiness, {
		status: readiness.status === 'ok' ? 200 : 503,
		headers: { 'cache-control': 'no-store' }
	})
}
