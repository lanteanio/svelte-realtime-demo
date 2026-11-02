import { MAX_STEP } from './shooter.shared.js'

/** The shared command codec receives movement batches and shot payloads. */
export function decodeClientCommand(command) {
	if (command === null || typeof command !== 'object' || Array.isArray(command)) throw new TypeError('Invalid shooter command')
	const keys = Object.keys(command)
	if (command.type === 'move' && keys.length === 3 && keys.every(key => ['type', 'dx', 'dy'].includes(key))
		&& typeof command.dx === 'number' && Number.isFinite(command.dx) && Math.abs(command.dx) <= MAX_STEP
		&& typeof command.dy === 'number' && Number.isFinite(command.dy) && Math.abs(command.dy) <= MAX_STEP) {
		return { type: 'move', dx: command.dx, dy: command.dy }
	}
	if (keys.length === 1 && keys[0] === 'angle' && typeof command.angle === 'number'
		&& Number.isFinite(command.angle) && Math.abs(command.angle) <= Math.PI) return { angle: command.angle }
	throw new TypeError('Invalid shooter command')
}

export const clientCommandCodec = { pack: decodeClientCommand, unpack: decodeClientCommand }
