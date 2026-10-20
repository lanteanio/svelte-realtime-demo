import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const dimensions = {
	device: ['desktop', 'mobile', 'tablet', 'unknown'],
	connection: ['slow-2g', '2g', '3g', '4g', 'unknown'],
	geography: ['africa', 'asia', 'europe', 'north-america', 'south-america', 'oceania', 'unknown']
}
const metrics = ['lcp', 'inp', 'cls']
const MAX_COUNT = 100_000_000
const MAX_BYTES = 5 * 1024 * 1024

function requireValue(condition, message) {
	if (!condition) throw new Error(message)
}

function object(value, keys, location) {
	requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${location}: expected an object`)
	requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${location}: unexpected or missing fields`)
}

function count(value, location) {
	requireValue(Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT, `${location}: invalid count`)
}

function day(value) {
	requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'window: expected a UTC calendar date')
	const date = new Date(`${value}T00:00:00.000Z`)
	requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'window: invalid calendar date')
	return date.getTime()
}

function metricSummary(metric, navigations, minimumSamples) {
	object(metric, ['eligibleCount', 'missingCount', 'distribution'], 'metric')
	count(metric.eligibleCount, 'metric.eligibleCount')
	count(metric.missingCount, 'metric.missingCount')
	requireValue(metric.eligibleCount <= navigations, 'metric: eligibility exceeds navigation count')
	requireValue(Array.isArray(metric.distribution) && metric.distribution.length <= 100_000, 'metric: invalid distribution')
	let samples = 0
	let previous = -1
	for (const entry of metric.distribution) {
		object(entry, ['value', 'count'], 'distribution entry')
		requireValue(typeof entry.value === 'number' && Number.isFinite(entry.value) && entry.value >= 0 && entry.value > previous, 'distribution: values must be finite, nonnegative and strictly increasing')
		count(entry.count, 'distribution.count')
		requireValue(entry.count > 0, 'distribution: counts must be positive')
		samples += entry.count
		previous = entry.value
	}
	requireValue(samples + metric.missingCount === metric.eligibleCount, 'metric: sample and missing counts must equal eligibility')
	let p75 = null
	let reason = samples === 0 ? 'no-samples' : 'insufficient-samples'
	if (samples >= minimumSamples) {
		const rank = Math.ceil(samples * 0.75)
		let cumulative = 0
		for (const entry of metric.distribution) {
			cumulative += entry.count
			if (cumulative >= rank) { p75 = entry.value; break }
		}
		reason = null
	}
	return { sampleCount: samples, eligibleCount: metric.eligibleCount, missingCount: metric.missingCount, ineligibleCount: navigations - metric.eligibleCount, p75, reason }
}

export function summarizeFieldPerformance(input, { minimumSamples = 20 } = {}) {
	count(minimumSamples, 'minimumSamples')
	requireValue(minimumSamples >= 20, 'minimumSamples: must be at least 20')
	object(input, ['schemaVersion', 'datasetKind', 'collectorVersion', 'window', 'coverage', 'segments'], 'export')
	requireValue(input.schemaVersion === 1, 'export: unsupported schema version')
	requireValue(['field', 'test'].includes(input.datasetKind), 'export: datasetKind must be field or test')
	requireValue(typeof input.collectorVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.collectorVersion), 'export: invalid collector version')
	object(input.window, ['start', 'end'], 'window')
	requireValue(day(input.window.start) < day(input.window.end), 'window: end must follow start')
	object(input.coverage, Object.keys(dimensions), 'coverage')
	for (const [dimension, allowed] of Object.entries(dimensions)) {
		const values = input.coverage[dimension]
		requireValue(Array.isArray(values) && values.length > 0 && values.length <= allowed.length && new Set(values).size === values.length && values.every(value => allowed.includes(value)), `coverage: invalid ${dimension}`)
	}
	requireValue(Array.isArray(input.segments) && input.segments.length <= 140, 'export: invalid segments')
	const rows = new Map()
	for (const segment of input.segments) {
		object(segment, [...Object.keys(dimensions), 'navigationCount', 'metrics'], 'segment')
		for (const dimension of Object.keys(dimensions)) requireValue(input.coverage[dimension].includes(segment[dimension]), `segment: undeclared ${dimension}`)
		const key = Object.keys(dimensions).map(dimension => segment[dimension]).join('/')
		requireValue(!rows.has(key), 'export: duplicate segment')
		count(segment.navigationCount, 'segment.navigationCount')
		object(segment.metrics, metrics, 'segment.metrics')
		rows.set(key, {
			device: segment.device, connection: segment.connection, geography: segment.geography,
			navigationCount: segment.navigationCount,
			metrics: Object.fromEntries(metrics.map(name => [name, metricSummary(segment.metrics[name], segment.navigationCount, minimumSamples)]))
		})
	}
	const segments = []
	for (const device of input.coverage.device) for (const connection of input.coverage.connection) for (const geography of input.coverage.geography) {
		segments.push(rows.get(`${device}/${connection}/${geography}`) ?? {
			device, connection, geography, navigationCount: null,
			metrics: Object.fromEntries(metrics.map(name => [name, { sampleCount: null, eligibleCount: null, missingCount: null, ineligibleCount: null, p75: null, reason: 'segment-not-collected' }]))
		})
	}
	return {
		schemaVersion: 1, datasetKind: input.datasetKind, sourceAuthenticity: 'unverified',
		collectorVersion: input.collectorVersion, window: { ...input.window },
		coverage: structuredClone(input.coverage), minimumSamples,
		percentileMethod: 'nearest-rank', units: { lcp: 'ms', inp: 'ms', cls: 'score' },
		segments
	}
}

export async function readFieldPerformance(path) {
	const file = await open(path, 'r')
	try {
		const bytes = Buffer.alloc(MAX_BYTES + 1)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length)
			if (bytesRead === 0) break
			length += bytesRead
		}
		requireValue(length <= MAX_BYTES, 'export: file exceeds 5 MiB')
		let input
		try { input = JSON.parse(bytes.toString('utf8', 0, length)) }
		catch { throw new Error('export: invalid JSON') }
		return summarizeFieldPerformance(input)
	} finally {
		await file.close()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		requireValue(process.argv.length === 3, 'usage: node scripts/field-performance.mjs EXPORT.json')
		console.log(JSON.stringify(await readFieldPerformance(process.argv[2]), null, 2))
	} catch {
		// Do not echo input, filenames or parser excerpts from rejected exports.
		console.error('Field performance export rejected. Check the documented format and file size.')
		process.exitCode = 1
	}
}
