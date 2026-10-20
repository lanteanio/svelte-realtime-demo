-- Preserve operation tracing when durable tasks resume on another worker.
ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS traceparent text;
ALTER TABLE demos_jobs_tasks ADD COLUMN IF NOT EXISTS tracestate text;
