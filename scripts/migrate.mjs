import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATION_LOCK_ID = 900000
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDir = join(root, 'migrations')
const connectionString = process.env.DATABASE_URL

if (!connectionString) {
	throw new Error('DATABASE_URL is required to run migrations')
}

const files = (await readdir(migrationsDir))
	.filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
	.sort()

if (files.length === 0) throw new Error(`No migrations found in ${migrationsDir}`)

const migrations = await Promise.all(files.map(async (name) => {
	// Checksums must be stable across Windows and Linux checkouts.
	const sql = (await readFile(join(migrationsDir, name), 'utf8')).replace(/\r\n?/g, '\n')
	const checksum = createHash('sha256').update(sql).digest('hex')
	return { name, sql, checksum }
}))

const client = new pg.Client({
	connectionString,
	connectionTimeoutMillis: 5000,
	query_timeout: 125_000
})
let connected = false

try {
	await client.connect()
	connected = true
	// Deployment must fail within a bounded window instead of waiting forever
	// behind another migrator or a conflicting table lock.
	await client.query("SET statement_timeout = '30s'")
	await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
	await client.query("SET statement_timeout = '120s'")
	await client.query("SET lock_timeout = '5s'")
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migration (
			schema_migration_id text        PRIMARY KEY,
			checksum   text        NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`)

	const { rows } = await client.query(`
		SELECT schema_migration_id, checksum
		  FROM schema_migration
	 ORDER BY schema_migration_id
	`)
	const applied = new Map(rows.map((row) => [row.schema_migration_id, row.checksum]))

	for (const [name, checksum] of applied) {
		const migration = migrations.find((candidate) => candidate.name === name)
		if (!migration) throw new Error(`Applied migration is missing from checkout: ${name}`)
		if (migration.checksum !== checksum) throw new Error(`Applied migration checksum changed: ${name}`)
	}

	for (const migration of migrations) {
		if (applied.has(migration.name)) continue
		console.log(`[migrate] applying ${migration.name}`)
		await client.query('BEGIN')
		try {
			await client.query(migration.sql)
			await client.query(
				'INSERT INTO schema_migration (schema_migration_id, checksum) VALUES ($1, $2)',
				[migration.name, migration.checksum]
			)
			await client.query('COMMIT')
		} catch (err) {
			await client.query('ROLLBACK')
			throw err
		}
	}

	console.log(`[migrate] schema current (${migrations.length} migration(s))`)
} finally {
	if (connected) {
		try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]) } catch { /* connection teardown releases it */ }
	}
	await client.end().catch(() => {})
}
