export function load({ cookies }) {
	const raw = cookies.get('identity')
	if (!raw) return { identity: null }
	try {
		return { identity: JSON.parse(raw) }
	} catch {
		return { identity: null }
	}
}
