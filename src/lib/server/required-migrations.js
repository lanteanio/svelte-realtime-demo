/**
 * Every checked-in migration. A replica reports the database ready only once
 * all of them are recorded in schema_migration.
 */
export const REQUIRED_MIGRATIONS = Object.freeze([
	'001_application_schema.sql',
	'002_demo_jobs.sql',
	'003_demo_jobs_erasure_columns.sql',
	'004_note_deletion_undo.sql',
	'005_demo_jobs_trace_context.sql',
	'006_demo_jobs_identity_receipts.sql'
])
