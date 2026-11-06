import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMigrations } from '../../scripts/migration-files.mjs'
import { REQUIRED_MIGRATIONS } from '../../src/lib/server/required-migrations.js'

test('readiness requires every checked-in migration', async () => {
	assert.deepEqual([...REQUIRED_MIGRATIONS], (await loadMigrations()).map((migration) => migration.name))
})
