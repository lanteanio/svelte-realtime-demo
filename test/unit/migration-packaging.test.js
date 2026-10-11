import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('runtime image scripts can discover packaged migrations', async () => {
	const root = new URL('../../', import.meta.url)
	const dockerfile = (await readFile(new URL('Dockerfile', root), 'utf8')).replaceAll('\r\n', '\n')
	const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
	const sources = [...runtime.matchAll(/^COPY (scripts\/[^\r\n]+) \.\/scripts\/$/gm)]
		.flatMap((match) => match[1].split(/\s+/))
	assert.ok(sources.includes('scripts/migrate.mjs'), 'runtime COPY must include the migrator')
	assert.match(runtime, /^COPY migrations \.\/migrations\/$/m)
	const image = await mkdtemp(join(tmpdir(), 'migration-image-'))
	try {
		await mkdir(join(image, 'scripts'))
		for (const source of sources) await cp(new URL(source, root), join(image, source))
		await cp(new URL('migrations/', root), join(image, 'migrations'), { recursive: true })
		const { loadMigrations } = await import(pathToFileURL(join(image, 'scripts/migration-files.mjs')))
		const migrations = await loadMigrations()
		assert.ok(migrations.some(({ name, sql }) => name === '004_note_deletion_undo.sql' && sql.includes('CREATE TABLE')))
	} finally {
		await rm(image, { recursive: true, force: true })
	}
})
