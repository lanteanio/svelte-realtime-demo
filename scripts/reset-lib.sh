#!/bin/bash
# Shared reset primitives sourced by reset-db.sh, reset-redis.sh and
# reset-all.sh, so the demo table list and the Redis flush live in ONE place -
# add a new demo table here only, and the three scripts stay in sync.

# Demo tables a database reset empties. Add new demo tables to this list.
RESET_DEMO_TABLES="demos_jobs_tasks demos_jobs_idempotency note board"

# FLUSHALL, honouring REDIS_PASSWORD when the container sets one.
flush_redis() {
	docker compose exec -T redis sh -c \
		'if [ -n "$REDIS_PASSWORD" ]; then exec redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL; else exec redis-cli FLUSHALL; fi'
}

# TRUNCATE every demo table that EXISTS. Existence-guarding matters: on a
# database where migrations never ran the demo tables are absent, and a plain
# TRUNCATE would error under `set -e` - in reset-all.sh that aborts AFTER Redis
# was already flushed, leaving the half-reset window this guard closes. On a
# migrated database it truncates all of them exactly as before.
truncate_demo_tables() {
	local quoted
	quoted=$(printf "'%s'," $RESET_DEMO_TABLES)
	quoted=${quoted%,}
	docker compose exec -T postgres psql -U postgres -d stickynotes -v ON_ERROR_STOP=1 -c "
DO \$do\$
DECLARE t text;
BEGIN
	FOR t IN SELECT unnest(ARRAY[$quoted]) LOOP
		IF to_regclass(t) IS NOT NULL THEN
			EXECUTE format('TRUNCATE TABLE %I CASCADE', t);
		END IF;
	END LOOP;
END
\$do\$;"
}
