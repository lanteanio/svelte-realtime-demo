export const writes = []
export const flags = []
export const live = handler => handler
export const defineTopics = topics => topics
live.effect = () => ({})
live.stream = () => ({})
live.flag = () => ({ set: value => flags.push(value) })
live.smooth = options => options
export class LiveError extends Error {
	constructor(code, message) { super(message); this.code = code }
}
export const redis = {
	redis: {
		multi() {
			return {
				lpush(key, value) { writes.push({ key, value }); return this },
				lrange() { return this },
				ltrim() { return this },
				async exec() { return [[null, 1], [null, []], [null, 1]] }
			}
		}
	}
}
export const leader = { isLeader: () => true }
