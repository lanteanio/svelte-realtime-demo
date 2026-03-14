import { LiveError } from 'svelte-realtime/server'

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

const LIMITS = {
	TITLE_MAX: 100,
	CONTENT_MAX: 2000,
	COORD_MIN: -10000,
	COORD_MAX: 10000,
	BACKGROUND_MAX: 7
}

export function validateBoardTitle(title) {
	if (typeof title !== 'string') throw new LiveError('VALIDATION', 'Title must be a string')
	const trimmed = title.trim()
	if (trimmed.length < 1) throw new LiveError('VALIDATION', 'Title required')
	if (trimmed.length > LIMITS.TITLE_MAX) throw new LiveError('VALIDATION', `Title must be ${LIMITS.TITLE_MAX} characters or less`)
	return trimmed
}

export function validateBackground(bg) {
	if (typeof bg !== 'string') throw new LiveError('VALIDATION', 'Background must be a string')
	if (!HEX_COLOR_RE.test(bg)) throw new LiveError('VALIDATION', 'Background must be a valid hex color')
	return bg
}

export function validateNoteContent(content) {
	if (typeof content !== 'string') throw new LiveError('VALIDATION', 'Content must be a string')
	if (content.length > LIMITS.CONTENT_MAX) throw new LiveError('VALIDATION', `Content must be ${LIMITS.CONTENT_MAX} characters or less`)
	return content
}

export function validateCoord(value, name) {
	const n = Number(value)
	if (!Number.isFinite(n)) throw new LiveError('VALIDATION', `${name} must be a number`)
	return Math.round(Math.max(LIMITS.COORD_MIN, Math.min(LIMITS.COORD_MAX, n)))
}

export function validateNoteColor(color) {
	if (typeof color !== 'string') throw new LiveError('VALIDATION', 'Color must be a string')
	if (!HEX_COLOR_RE.test(color)) throw new LiveError('VALIDATION', 'Color must be a valid hex color')
	return color
}

export function validateBoardFields(fields) {
	const clean = {}
	if (fields.title !== undefined) clean.title = validateBoardTitle(fields.title)
	if (fields.background !== undefined) clean.background = validateBackground(fields.background)
	return clean
}

export function validateZIndex(value) {
	const n = Number(value)
	if (!Number.isFinite(n) || n < 0) throw new LiveError('VALIDATION', 'z_index must be a non-negative number')
	return Math.round(n)
}

export function validateNoteFields(fields) {
	const clean = {}
	if (fields.content !== undefined) clean.content = validateNoteContent(fields.content)
	if (fields.x !== undefined) clean.x = validateCoord(fields.x, 'x')
	if (fields.y !== undefined) clean.y = validateCoord(fields.y, 'y')
	if (fields.color !== undefined) clean.color = validateNoteColor(fields.color)
	if (fields.z_index !== undefined) clean.z_index = validateZIndex(fields.z_index)
	return clean
}
