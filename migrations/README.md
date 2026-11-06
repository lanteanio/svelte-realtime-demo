# Database migrations

Run `node scripts/migrate.mjs` with `DATABASE_URL` set before starting or
replacing application workers. The runner serializes migrators with a bounded
PostgreSQL advisory lock, applies each file transactionally, and records its
SHA-256 checksum in `schema_migration` (keyed by `schema_migration_id`).

Migrations are forward-only and expand-compatible. A deployment rollback runs
the previous application image against the newer additive schema; it does not
run destructive down migrations. Never edit or remove an applied migration.
Add a new numbered file for every subsequent schema change.

SQL filenames must match `NNN_lowercase_name.sql`, with exactly three digits
and only lowercase letters, digits and underscores after the first underscore.
Discovery rejects every `.sql` file (case-insensitive extension) that violates
this rule, rather than silently skipping it.

Migrations must use unqualified object names and inherit the caller's schema.
A conservative text guard rejects the standalone tokens `public` and
`search_path`, case-insensitively, even in comments, quoted identifiers and
string literals. Do not change the schema through dynamic SQL or session
settings; the text guard is a project convention check, not a SQL parser or a
sandbox for arbitrary SQL.

`demos_jobs_tasks` and `demos_jobs_idempotency` deliberately retain the
upstream extension's published column/primary-key shapes; they are
third-party-owned integration tables rather than application schema.

`005_demo_jobs_trace_context.sql` adds the nullable W3C trace context columns
used by durable tasks. Existing rows remain valid without tracing; task writes
run with automatic DDL disabled.

`006_demo_jobs_identity_receipts.sql` brings both tables to the extension's
current schema: task status and attempt checks, the tenant identity stamp and
its per-tenant dispatch index, the `demos_jobs_tasks_receipts` enqueue receipt
table and idempotency owner tokens. Workers of the earlier release can keep
serving while it is applied and after a rollback: the demo's task runner sets
no erasure identity, so every task row stays unstamped. The integration suite
checks the migrated tables with the extension's schema validator.

Deletion undo uses `004_note_deletion_undo.sql`. The note deletion and its visitor-owned snapshot commit in one statement; restoring consumes the receipt and inserts the note in one statement. An existing note wins over the snapshot. Expired receipts are removed once a minute.

Run `npm run test:integration` with Docker available to start a disposable PostgreSQL container, apply the migrations and check deletion/restore behavior, concurrent board deletion, and durable task execution. The command binds a random loopback port and removes its container on success or failure. CI runs it for every push and pull request.

To use an existing disposable database instead, set `NOTE_UNDO_TEST_DATABASE_URL` and run `node --test test/integration/note-undo.postgres.test.js`. The test creates and removes its own random schema and selects it through the connection's `search_path`; it does not test the deployed database's `public` schema. It applies every accepted SQL migration in the same sorted order as the deployment runner. New migrations affect the tested schema only when they follow the unqualified-name convention above. Both paths share the filename and schema-token guards, and the unit suite checks the checked-in migrations against them.
