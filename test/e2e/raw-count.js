/**
 * The decision submitMood (privacy-helpers.js) polls on: what a raw count has
 * to beat, and whether a submission counted. Kept apart from the helpers that
 * drive a page, so the unit suite drives each branch without loading them.
 */

/**
 * How long after a minute begins a raw value is still taken as possibly the
 * closing window's. The framework publishes a window's final state when it
 * closes, and schedules that close from a clock it refreshes once a second, so
 * the publish can land up to about a second into the next minute; a second
 * close can follow up to about a second after the first.
 */
export const CLOSE_GRACE_MS = 2_000

/**
 * The count a submission has to beat, from what the raw card shows and when
 * that value arrived (epoch ms, null when the record cannot say).
 *
 * The card's n when the value arrived at least CLOSE_GRACE_MS after
 * `windowStart`, the start of the minute the submission lands in; 0 otherwise,
 * since the value is then possibly an earlier window's.
 *
 * @param {{ shown: number, arrivedAt: number | null, windowStart: number }} reading
 */
export function rawBaseline({ shown, arrivedAt, windowStart }) {
	const fromEarlierWindow = arrivedAt === null || arrivedAt < windowStart + CLOSE_GRACE_MS
	return { before: fromEarlierWindow ? 0 : shown, fromEarlierWindow }
}

/**
 * Whether a submission counted: the newest raw n delivered since the mark taken
 * just before the click (`delivered`, undefined when nothing arrived) is above
 * `before`, and the card shows exactly that n.
 *
 * @param {{ before: number, delivered: number | undefined, shown: number }} reading
 */
export function rawCounted({ before, delivered, shown }) {
	return delivered !== undefined && delivered > before && shown === delivered
}
