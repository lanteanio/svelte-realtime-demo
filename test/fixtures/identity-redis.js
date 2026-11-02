export const hashes = new Map()
export const availability = { failed: false, full: false }

export const redis = {
	key: key => `test:${key}`,
	redis: {
		async eval(script, keyCount, ...args) {
			if (availability.failed) throw new Error('Session store unavailable')
			const [key] = args
			if (keyCount === 2) return Object.entries(hashes.get(key) ?? {}).flat()
			if (availability.full) return 0
			const [, , , , , , , id, name, color, org] = args
			hashes.set(key, { id, name, color, org })
			return 1
		},
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
