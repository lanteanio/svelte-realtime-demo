import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AA_NORMAL, contrastRatio, labelColorOn, relativeLuminance } from '../../src/lib/label-contrast.js'
import { IDENTITY_COLORS } from '../../src/lib/names.js'

// A browser test draws ONE identity colour - whichever that visitor happened to
// get - so it can confirm the rule held for that draw and nothing more. The
// palette is a closed set of ten, so check all of them here.

test('every identity colour gets a label that clears WCAG AA for normal text', () => {
	assert.ok(IDENTITY_COLORS.length > 0, 'the palette is empty, so this test proves nothing')
	for (const color of IDENTITY_COLORS) {
		const label = labelColorOn(color)
		const ratio = contrastRatio(color, label)
		assert.ok(
			ratio >= AA_NORMAL,
			`${color} -> ${label} is ${ratio.toFixed(2)}:1, below the required ${AA_NORMAL}:1`
		)
	}
})

// The three the review named, with the ratios it measured. These are the
// regression: each was rendered white-on-colour and each is now far clear of
// the bar. Ratios are asserted with a tolerance rather than to the digit, so
// this pins the OUTCOME and not an implementation detail.
test('the colours the old rule got wrong are now well clear of the bar', () => {
	for (const [color, whiteRatio] of [['#14b8a6', 2.49], ['#3b82f6', 3.68], ['#f97316', 2.80]]) {
		// White really was that bad on these - the old rule chose it anyway.
		assert.ok(
			Math.abs(contrastRatio(color, '#ffffff') - whiteRatio) < 0.05,
			`expected white on ${color} to be about ${whiteRatio}:1, got ${contrastRatio(color, '#ffffff').toFixed(2)}`
		)
		assert.ok(contrastRatio(color, labelColorOn(color)) >= AA_NORMAL)
	}
})

// The specific defect: weighting gamma-encoded bytes and thresholding at 150.
// Reproduced here so the test states what was wrong rather than only that it
// is fixed - if someone reintroduces this shortcut, the first assertion below
// documents exactly why it looks plausible and is not.
test('the old gamma-encoded rule really did choose an unreadable label', () => {
	const gammaEncodedChoice = (color) => {
		const n = parseInt(color.slice(1), 16)
		const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
		return lum > 150 ? '#1f2937' : '#ffffff'
	}
	// #14b8a6 lands at about 147.9 on that scale, just under the threshold.
	assert.equal(gammaEncodedChoice('#14b8a6'), '#ffffff')
	assert.ok(contrastRatio('#14b8a6', '#ffffff') < AA_NORMAL)
	// ...and the corrected rule does not.
	assert.notEqual(labelColorOn('#14b8a6'), '#ffffff')
})

// #1f2937 was the old dark candidate. It is not dark enough for this palette:
// no label choice restricted to it and white can clear 4.5:1 on the blues and
// violets, which is why the fix uses true black.
test('the old dark candidate could not have satisfied the palette either', () => {
	const failures = IDENTITY_COLORS.filter((color) => {
		const dark = contrastRatio(color, '#1f2937')
		const light = contrastRatio(color, '#ffffff')
		return Math.max(dark, light) < AA_NORMAL
	})
	assert.ok(
		failures.length > 0,
		'expected #1f2937 to be insufficient for at least one identity colour'
	)
})

test('luminance and contrast follow the WCAG definitions', () => {
	assert.equal(relativeLuminance('#000000'), 0)
	assert.equal(relativeLuminance('#ffffff'), 1)
	// Black on white is the maximum possible ratio.
	assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01)
	assert.equal(contrastRatio('#123456', '#123456'), 1)
	// Order does not matter.
	assert.equal(contrastRatio('#14b8a6', '#ffffff'), contrastRatio('#ffffff', '#14b8a6'))
})

test('an unmeasurable background yields no label rather than a guess', () => {
	for (const bad of [null, undefined, '', 'rebeccapurple', 'hsl(210, 70%, 55%)', '#12345']) {
		assert.equal(labelColorOn(bad), null, `expected no label for ${JSON.stringify(bad)}`)
	}
	// Shorthand hex is still measurable.
	assert.equal(labelColorOn('#000'), '#ffffff')
})
