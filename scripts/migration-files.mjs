import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function loadMigrations(directory = fileURLToPath(new URL('../migrations/', import.meta.url))) {
	const files = (await readdir(directory))
		.filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
		.sort()
	if (files.length === 0) throw new Error(`No migrations found in ${directory}`)
	return Promise.all(files.map(async (name) => {
		// Checksums must be stable across Windows and Linux checkouts.
		const sql = (await readFile(join(directory, name), 'utf8')).replace(/\r\n?/g, '\n')
		const checksum = createHash('sha256').update(sql).digest('hex')
		return { name, sql, checksum }
	}))
}
