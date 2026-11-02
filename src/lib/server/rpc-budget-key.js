import { createHmac, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

// Address-derived Redis keys cannot be correlated across worker lifetimes.
const addressKey = randomBytes(32)

function addressBucket(address) {
	if (isIP(address) !== 6) return isIP(address) === 4 ? address : 'unknown'
	const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
	const [left, right] = canonical.split('::')
	const start = left ? left.split(':') : []
	const end = right ? right.split(':') : []
	const words = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
	if (words.slice(0, 5).every(word => parseInt(word, 16) === 0) && parseInt(words[5], 16) === 65535) {
		const high = parseInt(words[6], 16)
		const low = parseInt(words[7], 16)
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
	}
	return words.slice(0, 4).map(word => parseInt(word, 16).toString(16)).join(':')
}

/** Anonymous reconnects share a budget without retaining a source address. */
export function rpcBudgetKey(ws) {
	const user = ws.getUserData?.()
	if (user?.anonymous !== true && user?.id) return `user:${user.id}`
	const bucket = addressBucket(user?.remoteAddress ?? '')
	return `anonymous:${createHmac('sha256', addressKey).update(bucket).digest('hex')}`
}
