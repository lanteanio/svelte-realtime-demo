const dimensions = {
	device: ['desktop', 'mobile', 'tablet', 'unknown'],
	connection: ['slow-2g', '2g', '3g', '4g', 'unknown'],
	geography: ['unknown']
}
const metricNames = ['lcp', 'inp', 'cls']
const RETENTION_SECONDS = 32 * 24 * 60 * 60
const COLLECTOR_VERSION = '1.0.0'

function validDay(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const date = new Date(`${value}T00:00:00.000Z`)
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function keyFor(day, device, connection) {
	return `field-performance:${day}:${device}:${connection}:unknown`
}

export function fieldPerformanceEnabled() {
	return process.env.FIELD_PERFORMANCE_COLLECTION === '1'
}

export function parseFieldPerformanceSample(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid sample')
	const keys = ['schemaVersion', 'device', 'connection', 'metrics']
	if (Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))) throw new Error('invalid sample')
	if (input.schemaVersion !== 1 || !dimensions.device.includes(input.device) || !dimensions.connection.includes(input.connection)) throw new Error('invalid sample')
	if (!input.metrics || typeof input.metrics !== 'object' || Array.isArray(input.metrics)) throw new Error('invalid sample')
	if (Object.keys(input.metrics).length !== metricNames.length || !metricNames.every(key => Object.hasOwn(input.metrics, key))) throw new Error('invalid sample')
	const metrics = {}
	for (const name of metricNames) {
		const metric = input.metrics[name]
		if (!metric || typeof metric !== 'object' || Array.isArray(metric)) throw new Error('invalid sample')
		if (Object.keys(metric).length !== 2 || typeof metric.eligible !== 'boolean' || !Object.hasOwn(metric, 'value')) throw new Error('invalid sample')
		if (metric.value !== null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.value < 0 || metric.value > 3_600_000)) throw new Error('invalid sample')
		if (!metric.eligible && metric.value !== null) throw new Error('invalid sample')
		metrics[name] = { eligible: metric.eligible, value: metric.value }
	}
	return { device: input.device, connection: input.connection, metrics }
}

export async function recordFieldPerformanceSample(redis, input, now = new Date()) {
	const sample = parseFieldPerformanceSample(input)
	const day = now.toISOString().slice(0, 10)
	const key = keyFor(day, sample.device, sample.connection)
	const transaction = redis.multi()
	transaction.hincrby(key, 'navigationCount', 1)
	transaction.hset(key, 'collectorVersion', COLLECTOR_VERSION)
	for (const name of metricNames) {
		const metric = sample.metrics[name]
		if (!metric.eligible) continue
		transaction.hincrby(key, `${name}.eligibleCount`, 1)
		if (metric.value === null) transaction.hincrby(key, `${name}.missingCount`, 1)
		else transaction.hincrby(key, `${name}.value:${metric.value}`, 1)
	}
	transaction.expire(key, RETENTION_SECONDS)
	const results = await transaction.exec()
	for (const [cause] of results) if (cause) throw cause
}

function integer(values, key) {
	const value = Number(values[key] ?? 0)
	return Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function readFieldPerformanceDay(redis, day) {
	if (!validDay(day)) throw new Error('invalid day')
	const prefix = `field-performance:${day}:`
	const keys = []
	let cursor = '0'
	do {
		const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
		cursor = next
		keys.push(...batch)
	} while (cursor !== '0')
	const segments = []
	for (const key of keys.sort()) {
		const [, , device, connection, geography] = key.split(':')
		if (!dimensions.device.includes(device) || !dimensions.connection.includes(connection) || geography !== 'unknown') continue
		const values = await redis.hgetall(key)
		const navigationCount = integer(values, 'navigationCount')
		if (navigationCount === null) throw new Error('invalid stored sample')
		const metrics = {}
		for (const name of metricNames) {
			const eligibleCount = integer(values, `${name}.eligibleCount`)
			const missingCount = integer(values, `${name}.missingCount`)
			if (eligibleCount === null || missingCount === null) throw new Error('invalid stored sample')
			const entries = []
			for (const [field, count] of Object.entries(values)) {
				if (!field.startsWith(`${name}.value:`)) continue
				const value = Number(field.slice(name.length + 7))
				const occurrences = Number(count)
				if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(occurrences) || occurrences <= 0) throw new Error('invalid stored sample')
				entries.push({ value, count: occurrences })
			}
			entries.sort((a, b) => a.value - b.value)
			metrics[name] = { eligibleCount, missingCount, distribution: entries }
		}
		segments.push({ device, connection, geography, navigationCount, metrics })
	}
	return {
		schemaVersion: 1,
		datasetKind: 'field',
		collectorVersion: COLLECTOR_VERSION,
		window: { start: day, end: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10) },
		coverage: dimensions,
		segments
	}
}
