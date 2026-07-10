-- Durable jobs demo tables. These mirror the installed extension's schema;
-- createTaskRunner/createIdempotencyStore run with autoMigrate:false.
-- Forward-only/expand-compatible: prior app images tolerate these extra tables.

CREATE TABLE IF NOT EXISTS demos_jobs_tasks (
    svti_tasks_id        uuid        PRIMARY KEY,
    name                 text        NOT NULL,
    input                jsonb,
    svti_idempotency_key text,
    request_id           text,
    status               text        NOT NULL,
    result               jsonb,
    error                jsonb,
    fence                uuid        NOT NULL,
    fence_expires_at     timestamptz NOT NULL,
    attempts             integer     NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_running_fence
    ON demos_jobs_tasks (fence_expires_at)
 WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_demos_jobs_tasks_terminal_updated
    ON demos_jobs_tasks (updated_at)
 WHERE status IN ('committed', 'failed');

CREATE TABLE IF NOT EXISTS demos_jobs_idempotency (
    svti_idempotency_key text        PRIMARY KEY,
    status               text        NOT NULL,
    result               jsonb,
    expires_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demos_jobs_idempotency_expires_at
    ON demos_jobs_idempotency (expires_at);
