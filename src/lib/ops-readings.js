/**
 * Rendering rules for the ops dashboard's numbers.
 *
 * The dashboard's whole value is that its readings are trustworthy, so
 * the one thing it must never do is present a number nobody measured.
 * Two distinct hazards, deliberately handled apart:
 *
 *  1. ABSENT fields. Optional parts of the snapshot (platform-specific
 *     kernel signals, stores that are not configured, anything before
 *     the first poll resolves) are simply missing. `?? 0` turned those
 *     into measured zeros; `reading()` reports them as no reading and
 *     leaves a genuine measured 0 intact.
 *
 *  2. PLACEHOLDER zeros. The adapter initialises its pressure snapshot
 *     with `memoryMB: 0` and overwrites it on the first ~1Hz sampler
 *     tick, so RSS is always present and reads 0 until sampling starts
 *     - which is exactly the window a freshly opened dashboard is read
 *     in. No live process occupies 0 MB, so `rssReading()` treats zero
 *     as "not sampled yet". That impossibility rule is specific to RSS
 *     and deliberately not generalised: publish rate, backpressured
 *     connections and the rest are legitimately zero all the time.
 *     Filed upstream so consumers stop needing rules like this one.
 */

/** Rendered in place of a number nobody measured. */
export const NO_READING = '-'

/** True when `value` is an actual finite numeric reading. */
export function isReading(value) {
	return typeof value === 'number' && Number.isFinite(value)
}

/**
 * A count (integer-ish) or the no-reading marker. A measured zero
 * renders as `0`.
 */
export function reading(value) {
	return isReading(value) ? String(value) : NO_READING
}

/** A fixed-precision statistic, or the no-reading marker. */
export function statReading(value, digits = 0) {
	return isReading(value) ? value.toFixed(digits) : NO_READING
}

/**
 * RSS in MB. Zero means the sampler has not run yet, not that the
 * process is weightless, so it reports as no reading.
 */
export function rssReading(memoryMB) {
	return isReading(memoryMB) && memoryMB > 0 ? statReading(memoryMB) : NO_READING
}
