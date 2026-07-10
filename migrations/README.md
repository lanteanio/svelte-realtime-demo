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
