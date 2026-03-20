/**
 * Input validation for all RPC calls.
 *
 * Every field that comes from a client gets validated here before
 * touching the database. If validation fails, we throw a LiveError
 * which the client receives as a structured error (not a raw crash).
 *
 * Rule of thumb: never trust client input. Validate type, format,
 * length, and range. The database has constraints too (foreign keys,
 * unique indexes), but catching errors here gives better messages.
 */

import { LiveError } from 'svelte-realtime/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

const LIMITS = {
	TITLE_MAX: 100,
	CONTENT_MAX: 2000,
	COORD_MIN: -10000,
	COORD_MAX: 10000,
	BACKGROUND_MAX: 7
}

// --- Scalar validators ---
// Each returns the cleaned value or throws a LiveError.

export function validateBoardId(boardId) {
	if (typeof boardId !== 'string' || !UUID_RE.test(boardId)) {
		throw new LiveError('VALIDATION', 'Invalid board ID')
	}
	return boardId
}

export function validateNoteId(noteId) {
	if (typeof noteId !== 'string' || !UUID_RE.test(noteId)) {
		throw new LiveError('VALIDATION', 'Invalid note ID')
	}
	return noteId
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

/** Clamps coordinates to the allowed range. No error -- just caps the value. */
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

export function validateZIndex(value) {
	const n = Number(value)
	if (!Number.isFinite(n) || n < 0) throw new LiveError('VALIDATION', 'z_index must be a non-negative number')
	return Math.round(n)
}

// --- Object validators ---
// Validate a bag of fields, returning only the valid ones.
// Unknown fields are silently dropped (allowlist pattern).

function assertPlainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new LiveError('VALIDATION', 'Invalid update payload')
	}
}

export function validateBoardFields(fields) {
	assertPlainObject(fields)
	const clean = {}
	if (fields.title !== undefined) clean.title = validateBoardTitle(fields.title)
	if (fields.background !== undefined) clean.background = validateBackground(fields.background)
	return clean
}

export function validateNoteFields(fields) {
	assertPlainObject(fields)
	const clean = {}
	if (fields.content !== undefined) clean.content = validateNoteContent(fields.content)
	if (fields.x !== undefined) clean.x = validateCoord(fields.x, 'x')
	if (fields.y !== undefined) clean.y = validateCoord(fields.y, 'y')
	if (fields.color !== undefined) clean.color = validateNoteColor(fields.color)
	if (fields.z_index !== undefined) clean.z_index = validateZIndex(fields.z_index)
	return clean
}
