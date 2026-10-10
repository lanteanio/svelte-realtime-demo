export const hashes = new Map()
export const availability = { failed: false }

export const redis = {
	key: key => `test:${key}`,
	redis: {
		multi() {
			const commands = []
			return {
				hset(key, value) { commands.push(() => { hashes.set(key, { ...value }); return 1 }); return this },
				hgetall(key) { commands.push(() => ({ ...hashes.get(key) })); return this },
				expire() { commands.push(() => 1); return this },
				async exec() {
					if (availability.failed) throw new Error('Session store unavailable')
					return commands.map(command => [null, command()])
				}
			}
		}
	}
}
