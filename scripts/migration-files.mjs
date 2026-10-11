import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function loadMigrations(directory = fileURLToPath(new URL('../migrations/', import.meta.url))) {
	const files = (await readdir(directory)).filter((name) => /\.sql$/i.test(name)).sort()
	for (const name of files) {
		if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) throw new Error(`Invalid migration filename: ${name}`)
	}
	if (files.length === 0) throw new Error(`No migrations found in ${directory}`)
	return Promise.all(files.map(async (name) => {
		// Checksums must be stable across Windows and Linux checkouts.
		const sql = (await readFile(join(directory, name), 'utf8')).replace(/\r\n?/g, '\n')
		// Deliberately conservative text guard, including comments and literals:
		// migrations must inherit the caller's schema in deployment and tests.
		if (/\b(?:public|search_path)\b/i.test(sql)) {
			throw new Error(`Migration ${name} must not contain public or search_path tokens`)
		}
		const checksum = createHash('sha256').update(sql).digest('hex')
		return { name, sql, checksum }
	}))
}
