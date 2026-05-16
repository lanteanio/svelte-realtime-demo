#!/bin/bash
# Creates the non-superuser application role on first Postgres init.
# Runs from /docker-entrypoint-initdb.d/ which only executes once when the
# data volume is freshly initialized; subsequent container starts skip this
# entirely. Operators upgrading an existing deployment must create the role
# manually - see the CHANGELOG entry for the one-shot SQL.
set -euo pipefail

if [ -z "${STICKYNOTES_APP_PASSWORD:-}" ]; then
	echo "[init-app-role] STICKYNOTES_APP_PASSWORD is required" >&2
	exit 1
fi

# psql -v sets a variable usable as :'app_password' in the SQL below.
# Using the substitution form is safer than interpolating into the command
# string: psql handles quoting + escaping for SQL string literals.
psql -v ON_ERROR_STOP=1 \
	-v app_password="$STICKYNOTES_APP_PASSWORD" \
	--username "$POSTGRES_USER" \
	--dbname "$POSTGRES_DB" <<-'EOSQL'
	DO $$
	BEGIN
		IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stickynotes_app') THEN
			CREATE ROLE stickynotes_app WITH LOGIN PASSWORD NULL;
		END IF;
	END
	$$;
	ALTER ROLE stickynotes_app WITH PASSWORD :'app_password';
	-- Postgres 15+ revoked CREATE on schema public from PUBLIC by default;
	-- the app role needs both USAGE (to reference objects in the schema)
	-- and CREATE (to CREATE TABLE / CREATE FUNCTION when the SET ROLE
	-- block in 01-schema.sql runs).
	GRANT USAGE, CREATE ON SCHEMA public TO stickynotes_app;
EOSQL

echo "[init-app-role] stickynotes_app role created and granted USAGE+CREATE on schema public"
