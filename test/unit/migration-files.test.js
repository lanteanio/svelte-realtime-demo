import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadMigrations } from '../../scripts/migration-files.mjs'

test('checked-in migrations satisfy filename and schema isolation guards', async () => {
	assert.ok((await loadMigrations()).length > 0)
})

test('migration discovery rejects every invalid SQL filename before silently omitting it', async () => {
	for (const name of ['013-dash.sql', '012_Upper.sql', '014_ok.SQL', '9_short.sql', '0010_long.sql']) {
		const directory = await mkdtemp(join(tmpdir(), 'migration-names-'))
		try {
			await writeFile(join(directory, '001_valid.sql'), 'SELECT 1;')
			await writeFile(join(directory, name), 'SELECT 2;')
			await assert.rejects(loadMigrations(directory), { message: `Invalid migration filename: ${name}` })
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}
})

test('migration discovery refuses schema escapes before either caller can execute SQL', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'migration-schema-'))
	try {
		for (const sql of [
			'ALTER TABLE public.note ADD COLUMN probe integer;',
			'ALTER TABLE "public"."note" ADD COLUMN probe integer;',
			'ALTER TABLE PUBLIC /* nested /* comment */ */ .note ADD COLUMN probe integer;',
			'SET search_path TO public;',
			'SET LOCAL "search_path" TO another_schema;',
			"SELECT set_config('search_path', 'another_schema', false);",
			'RESET SEARCH_PATH;',
			'-- public schema mentioned in a comment is conservatively refused',
			"SELECT 'search_path';"
		]) {
			await writeFile(join(directory, '001_test.sql'), sql)
			await assert.rejects(loadMigrations(directory), /must not contain public or search_path tokens/)
		}
		await writeFile(join(directory, '001_test.sql'), 'CREATE TABLE note (note_id integer);\r\n')
		await writeFile(join(directory, '002_next.sql'), 'ALTER TABLE note ADD COLUMN publication text;\n')
		await writeFile(join(directory, 'README.md'), 'Non-SQL documentation is ignored.')
		const migrations = await loadMigrations(directory)
		assert.deepEqual(migrations.map(({ name }) => name), ['001_test.sql', '002_next.sql'])
		assert.equal(migrations[0].sql, 'CREATE TABLE note (note_id integer);\n')
		assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
