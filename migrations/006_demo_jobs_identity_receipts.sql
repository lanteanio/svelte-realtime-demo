-- Durable task tables at the extension's current schema: task status and
-- attempt checks, the tenant identity stamp, per-tenant dispatch, enqueue
-- receipts, and idempotency owner tokens. Columns, checks and indexes are
-- added only if absent; the creation-order pending index the per-tenant one
-- replaces is dropped if present. Plain CREATE INDEX: the runner applies each
-- file in one transaction.

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_tasks ADD CONSTRAINT chk_demos_jobs_tasks_status
        CHECK (status = 'pending' OR status = 'running' OR status = 'committed' OR status = 'failed') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_tasks VALIDATE CONSTRAINT chk_demos_jobs_tasks_status;

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_tasks ADD CONSTRAINT chk_demos_jobs_tasks_attempts
        CHECK (attempts >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_tasks VALIDATE CONSTRAINT chk_demos_jobs_tasks_attempts;

ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS identity_version integer;
ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS tenant_id text;

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_tasks ADD CONSTRAINT chk_demos_jobs_tasks_identity
        CHECK ((identity_version IS NULL AND tenant_id IS NULL) OR (identity_version IS NOT NULL AND identity_version = 1)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_tasks VALIDATE CONSTRAINT chk_demos_jobs_tasks_identity;

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_identity
    ON demos_jobs_tasks (identity_version, tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_pending_scope
    ON demos_jobs_tasks (identity_version, name, tenant_id, created_at)
 WHERE status = 'pending';

DROP INDEX IF EXISTS idx_demos_jobs_tasks_pending_created;

CREATE TABLE IF NOT EXISTS demos_jobs_tasks_receipts (
    scope            text    PRIMARY KEY,
    svti_tasks_id    uuid    NOT NULL,
    input            text    NOT NULL,
    identity_version integer,
    tenant_id        text,
    user_id          text,
    created_at       bigint  NOT NULL,
    dedup_expires_at bigint  NOT NULL
);

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_tasks_receipts ADD CONSTRAINT chk_demos_jobs_tasks_rcpt_owner
        CHECK ((identity_version IS NULL AND tenant_id IS NULL) OR (identity_version IS NOT NULL AND identity_version = 1)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_tasks_receipts VALIDATE CONSTRAINT chk_demos_jobs_tasks_rcpt_owner;

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_tasks_receipts ADD CONSTRAINT chk_demos_jobs_tasks_rcpt_expiry
        CHECK (dedup_expires_at > created_at) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_tasks_receipts VALIDATE CONSTRAINT chk_demos_jobs_tasks_rcpt_expiry;

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_rcpt_expiry
    ON demos_jobs_tasks_receipts (dedup_expires_at);

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_rcpt_owner
    ON demos_jobs_tasks_receipts (identity_version, tenant_id, user_id);

ALTER TABLE demos_jobs_idempotency ADD COLUMN IF NOT EXISTS owner_token text;

DO $migration$ BEGIN
    ALTER TABLE demos_jobs_idempotency ADD CONSTRAINT chk_demos_jobs_idempotency_status
        CHECK (status = 'pending' OR status = 'committed') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $migration$;
ALTER TABLE demos_jobs_idempotency VALIDATE CONSTRAINT chk_demos_jobs_idempotency_status;
