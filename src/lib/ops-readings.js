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
 *  2. UNSAMPLED snapshots. The transport pressure snapshot exists from
 *     process start with every field at 0 and is overwritten when the
 *     ~1Hz sampler folds, so inside that window the whole object is
 *     placeholders. No per-field rule can find that out: 0 is the
 *     honest steady-state reading for publish rate, buffered bytes and
 *     backpressured connections on an idle worker. `sampledAt` dates
 *     the snapshot instead - null before the first fold, wall-clock ms
 *     after - so one branch qualifies every field at once. Being a
 *     timestamp, it also separates a fresh reading from the stale one
 *     a wedged sampler leaves behind, which `pressureState()` reports
 *     as its own state rather than folding into either neighbour.
 */

/** Rendered in place of a number nobody measured. */
export const NO_READING = '-'

/**
 * How old the newest pressure sample may be before the sampler counts
 * as wedged rather than merely between ticks. The adapter folds at ~1Hz
 * and this page polls every 3s, so a healthy age is well under a
 * second and the margin here is wide enough that a tick delayed by a
 * busy event loop is not reported as a fault.
 */
export const SAMPLE_STALE_MS = 5000

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
 * Which of four states the admission-posture panel is in:
 *
 *   'missing'   - no pressure snapshot at all (adapter without one).
 *   'unsampled' - a snapshot whose fields are still placeholders.
 *   'stale'     - real readings, but older than the sampler's period.
 *   'live'      - measured within the last sampling period.
 *
 * `ageMs` must be measured on the worker that took the sample, because
 * `sampledAt` is that worker's wall clock and a browser's clock has no
 * fixed relation to it; a client-side subtraction reports clock skew as
 * staleness. Pass null when there is no age to hand over, which keeps a
 * dated snapshot 'live' rather than inventing a fault.
 *
 * An undated snapshot reads as 'unsampled' whether the field is null or
 * absent: an adapter old enough not to stamp its samples cannot vouch
 * for the numbers in them either, and "nobody measured this" is the
 * honest rendering of both.
 */
export function pressureState(pressure, ageMs) {
	if (!pressure) return 'missing'
	if (!isReading(pressure.sampledAt)) return 'unsampled'
	return isReading(ageMs) && ageMs > SAMPLE_STALE_MS ? 'stale' : 'live'
}

/**
 * A sample age in tenths of a second, for the freshness caption. Not
 * clamped at zero: an age below it means the stamp and the clock that
 * aged it came from different processes, and a caption reading "-0.4s
 * ago" is the visible form of that. Clamping would present the same
 * broken pairing as a perfectly fresh sample.
 */
export function ageReading(ageMs) {
	return isReading(ageMs) ? statReading(ageMs / 1000, 1) : NO_READING
}
