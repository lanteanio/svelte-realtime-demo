# Database migrations

Run `node scripts/migrate.mjs` with `DATABASE_URL` set before starting or
replacing application workers. The runner serializes migrators with a bounded
PostgreSQL advisory lock, applies each file transactionally, and records its
SHA-256 checksum in `schema_migration` (keyed by `schema_migration_id`).

Migrations are forward-only and expand-compatible. A deployment rollback runs
the previous application image against the newer additive schema; it does not
run destructive down migrations. Never edit or remove an applied migration.
Add a new numbered file for every subsequent schema change.

`demos_jobs_tasks` and `demos_jobs_idempotency` deliberately retain the
upstream extension's published column/primary-key shapes; they are
third-party-owned integration tables rather than application schema.

Deletion undo uses `004_note_deletion_undo.sql`. The note deletion and its visitor-owned snapshot commit in one statement; restoring consumes the receipt and inserts the note in one statement. An existing note wins over the snapshot. Expired receipts are removed once a minute.

To check these operations against a disposable PostgreSQL database, set `NOTE_UNDO_TEST_DATABASE_URL` and run `node --test test/integration/note-undo.postgres.test.js`. The test creates and removes its own schema.
