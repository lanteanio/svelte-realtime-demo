// Readable label colours on arbitrary identity backgrounds.
//
// Roster chips and cursor tags paint a name over a per-user colour. The
// previous rule weighted the GAMMA-ENCODED sRGB bytes with the BT.709
// coefficients and thresholded the result at 150. Both halves are wrong: sRGB
// channels have to be linearised before those coefficients mean anything, and
// a luminance threshold is not a contrast ratio. It picked white for
// #14b8a6 (2.49:1), #3b82f6 (3.68:1) and #f97316 (2.80:1), every one of them
// far short of the 4.5:1 WCAG 1.4.3 asks of normal-size text - which is what
// a text-xs chip and a 10px cursor tag are.
//
// Lives here rather than in the page so the whole palette can be checked at
// once: a browser test only ever draws the one colour that visitor happened to
// get, so it can confirm the rule holds for that draw and nothing more.

/** WCAG 1.4.3 minimum contrast for normal-size text. */
export const AA_NORMAL = 4.5

const DARK = '#000000'
const LIGHT = '#ffffff'

function channel(byte) {
	const value = byte / 255
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/**
 * Parse `#rgb` or `#rrggbb` into byte triples.
 * @param {string | null | undefined} color
 * @returns {[number, number, number] | null} null when unparseable
 */
export function parseHex(color) {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? '').trim())
	if (!match) return null
	const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1]
	const n = parseInt(hex, 16)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * WCAG relative luminance.
 * @param {string | null | undefined} color
 * @returns {number | null} null when the colour cannot be measured
 */
export function relativeLuminance(color) {
	const rgb = parseHex(color)
	if (!rgb) return null
	return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/**
 * WCAG contrast ratio between two colours, 1..21.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number | null} null when either colour cannot be measured
 */
export function contrastRatio(a, b) {
	const la = relativeLuminance(a)
	const lb = relativeLuminance(b)
	if (la === null || lb === null) return null
	const [hi, lo] = la > lb ? [la, lb] : [lb, la]
	return (hi + 0.05) / (lo + 0.05)
}

/**
 * The label colour to paint on `background`: whichever of black or white
 * actually contrasts better, measured rather than thresholded.
 *
 * Returns null when the background cannot be measured, so a caller can leave
 * the colour alone instead of guessing. A fixed guess is what produced
 * white-on-pale, and an unmeasurable background is exactly where a guess is
 * least defensible.
 *
 * @param {string | null | undefined} background
 * @returns {string | null}
 */
export function labelColorOn(background) {
	const dark = contrastRatio(background, DARK)
	const light = contrastRatio(background, LIGHT)
	if (dark === null || light === null) return null
	return dark >= light ? DARK : LIGHT
}
