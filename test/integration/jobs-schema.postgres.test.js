import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import pg from 'pg'
import { createPgClient, validateSchema } from 'svelte-adapter-uws-extensions/postgres'
import { createTaskRunner } from 'svelte-adapter-uws-extensions/postgres/tasks'
import { loadMigrations } from '../../scripts/migration-files.mjs'

const connectionString = process.env.POSTGRES_TEST_DATABASE_URL
assert.ok(connectionString, 'POSTGRES_TEST_DATABASE_URL must name a disposable PostgreSQL database')
const schema = `jobs_${crypto.randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString })
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
let tasks

before(async () => {
	await admin.query(`CREATE SCHEMA ${schema}`)
	for (const migration of await loadMigrations()) await pool.query(migration.sql)
	tasks = createTaskRunner(createPgClient({ pool }), {
		table: 'demos_jobs_tasks', autoMigrate: false,
		recoveryInterval: 0, dispatchInterval: 0, cleanupInterval: 0
	})
})

after(async () => {
	tasks?.destroy()
	await pool.end()
	await admin.query(`DROP SCHEMA ${schema} CASCADE`)
	await admin.end()
})

test('the migrated jobs schema runs a traced task with automatic DDL disabled', async () => {
	const traceContext = {
		traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
		tracestate: 'demo=sample'
	}
	tasks.register('schema-check', async (ctx) => ({ value: ctx.input.value }))
	assert.deepEqual(await tasks.run('schema-check', { input: { value: 37 }, traceContext }), { value: 37 })
	const { rows: [row] } = await pool.query('SELECT status, result, traceparent, tracestate FROM demos_jobs_tasks')
	assert.equal(row.status, 'committed')
	assert.deepEqual(row.result, { value: 37 })
	assert.equal(row.traceparent, traceContext.traceparent)
	assert.equal(row.tracestate, traceContext.tracestate)
})

test('the migrated job tables match the extension schema', async () => {
	const client = createPgClient({ pool })
	await validateSchema(client, { store: 'tasks', table: 'demos_jobs_tasks' })
	await validateSchema(client, { store: 'idempotency', table: 'demos_jobs_idempotency' })
})
