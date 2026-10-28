import assert from 'node:assert/strict'
import test from 'node:test'
import { collectFieldPerformance, fieldPerformanceConnection, fieldPerformanceDevice } from '../../src/lib/field-performance.js'

function browserFixture() {
	const observers = new Map()
	const listeners = new Map()
	const beacons = []
	class PerformanceObserver {
		constructor(callback) { this.callback = callback }
		observe({ type }) { observers.set(type, this) }
		disconnect() {}
	}
	const document = {
		visibilityState: 'visible',
		addEventListener(name, callback) { listeners.set(name, callback) },
		removeEventListener(name) { listeners.delete(name) }
	}
	const window = {
		document, PerformanceObserver, innerWidth: 390,
		matchMedia: () => ({ matches: true }),
		addEventListener(name, callback) { listeners.set(name, callback) },
		removeEventListener(name) { listeners.delete(name) },
		navigator: {
			connection: { effectiveType: '4g' },
			sendBeacon(endpoint, body) { beacons.push({ endpoint, body }); return true }
		},
		fetch: async () => { throw new Error('unexpected fallback') }
	}
	return {
		window, beacons, listeners,
		emit(type, entries) { observers.get(type).callback({ getEntries: () => entries }) },
		hide() { document.visibilityState = 'hidden'; listeners.get('visibilitychange')() }
	}
}

test('device and connection labels are bounded and never inferred from identity', () => {
	assert.equal(fieldPerformanceDevice({}, { innerWidth: 390, matchMedia: () => ({ matches: true }) }), 'mobile')
	assert.equal(fieldPerformanceDevice({}, { innerWidth: 900, matchMedia: () => ({ matches: true }) }), 'tablet')
	assert.equal(fieldPerformanceDevice({}, { innerWidth: 900, matchMedia: () => ({ matches: false }) }), 'desktop')
	assert.equal(fieldPerformanceConnection({ connection: { effectiveType: '3g' } }), '3g')
	assert.equal(fieldPerformanceConnection({ connection: { effectiveType: '5g' } }), 'unknown')
})

test('the collector sends one aggregate-only navigation sample', async () => {
	const fixture = browserFixture()
	const cleanup = collectFieldPerformance(fixture.window)
	fixture.emit('largest-contentful-paint', [{ startTime: 900.4 }, { startTime: 1100.6 }])
	fixture.emit('layout-shift', [{ value: 0.02, hadRecentInput: false }, { value: 0.2, hadRecentInput: true }, { value: 0.02, hadRecentInput: false }])
	fixture.emit('event', [{ interactionId: 0, duration: 200 }, { interactionId: 7, duration: 80 }, { interactionId: 8, duration: 120 }])
	fixture.hide()
	fixture.hide()
	assert.equal(fixture.beacons.length, 1)
	const body = JSON.parse(await fixture.beacons[0].body.text())
	assert.deepEqual(body, {
		schemaVersion: 1,
		device: 'mobile', connection: '4g',
		metrics: {
			lcp: { eligible: true, value: 1101 },
			inp: { eligible: true, value: 120 },
			cls: { eligible: true, value: 0.04 }
		}
	})
	cleanup()
	assert.equal(fixture.listeners.size, 0)
})

test('no interaction makes INP ineligible and unsupported metrics stay null', async () => {
	const fixture = browserFixture()
	collectFieldPerformance(fixture.window)
	fixture.hide()
	const body = JSON.parse(await fixture.beacons[0].body.text())
	assert.deepEqual(body.metrics.inp, { eligible: false, value: null })
	assert.deepEqual(body.metrics.lcp, { eligible: true, value: null })
	assert.deepEqual(body.metrics.cls, { eligible: true, value: 0 })
})

test('pagehide sends even before the document becomes hidden', async () => {
	const fixture = browserFixture()
	collectFieldPerformance(fixture.window)
	fixture.listeners.get('pagehide')({ type: 'pagehide' })
	assert.equal(fixture.beacons.length, 1)
})
