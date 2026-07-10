-- Bring the demos_jobs_* mirrors up to the 0.6 extension schema. The 0.6 line
-- stamps user_id (and tenant_id on idempotency rows) so a user's rows can be
-- purged from the durable stores; the extension forward-migrates these itself
-- when it owns the schema, but these tables run autoMigrate:false, so the
-- mirror carries the same forward-only ALTERs here (index shapes identical to
-- the extension's own).

ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS user_id text;

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_user
    ON demos_jobs_tasks (user_id);

ALTER TABLE demos_jobs_idempotency ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE demos_jobs_idempotency ADD COLUMN IF NOT EXISTS tenant_id text;

CREATE INDEX IF NOT EXISTS idx_demos_jobs_idempotency_user
    ON demos_jobs_idempotency (tenant_id, user_id);
