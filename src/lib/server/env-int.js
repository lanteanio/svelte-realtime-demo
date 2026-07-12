// @ts-check

/**
 * Parse an environment value as a bounded integer: return it when it is a whole
 * number within [min, max], otherwise return the fallback. Operational env
 * knobs are integers by contract, so a fractional, non-numeric, or out-of-range
 * value is treated as absent (fall back to the default) rather than silently
 * coerced - the single place this project reads a bounded-int knob, so every
 * caller shares one acceptance rule.
 *
 * @param {unknown} value raw env value (string | undefined)
 * @param {{ min?: number, max?: number, fallback: number }} bounds
 * @returns {number}
 */
export function boundedIntEnv(value, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback }) {
	const parsed = Number(value)
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}
