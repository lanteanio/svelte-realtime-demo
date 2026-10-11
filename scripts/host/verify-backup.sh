#!/bin/bash
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [ "$#" -ne 2 ]; then echo 'usage: verify-backup.sh ABSOLUTE_BACKUP_DIRECTORY NEW_RESULT_DIRECTORY' >&2; exit 64; fi
backup=$1
work=$2
test "$(realpath -e -- "$backup")" = "$backup"
test ! -L "$backup"
[[ "$backup" != *','* && "$backup" != *$'\n'* ]]
[[ "$work" == /* && ! -e "$work" && "$work" != *','* && "$work" != *$'\n'* ]]
for name in database.dump roles.sql redis.rdb configuration.tgz; do
  test -f "$backup/$name"
  test ! -L "$backup/$name"
done
mkdir -m 700 -- "$work"
date -u +%Y-%m-%dT%H:%M:%SZ > "$work/started-at.txt"
test "$(realpath -e -- "$work")" = "$work"
stamp=$(cat /proc/sys/kernel/random/uuid)
pg_name=maintenance-pg-$stamp
redis_name=maintenance-redis-$stamp
pg_id=$(docker compose ps -q postgres)
redis_id=$(docker compose ps -q redis)
[[ "$pg_id" =~ ^[a-f0-9]{64}$ && "$redis_id" =~ ^[a-f0-9]{64}$ ]]
pg_image=$(docker inspect --format '{{.Image}}' "$pg_id")
redis_image=$(docker inspect --format '{{.Image}}' "$redis_id")
[[ "$pg_image" =~ ^sha256:[a-f0-9]{64}$ && "$redis_image" =~ ^sha256:[a-f0-9]{64}$ ]]
for id in "$pg_id" "$redis_id"; do
  test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$id")" = 'true healthy'
done
source_db=$(docker compose exec -T postgres sh -c 'printf "%s" "$POSTGRES_DB"' </dev/null)
[[ "$source_db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]
for name in database.dump roles.sql redis.rdb configuration.tgz; do sha256sum -- "$backup/$name"; done > "$work/input-sha256.txt"
printf 'postgres_image=%s\nredis_image=%s\n' "$pg_image" "$redis_image" > "$work/images.txt"
cleanup() {
  for name in "$pg_name" "$redis_name"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      test "$(docker inspect --format '{{index .Config.Labels "maintenance.restore"}}' "$name")" = "$stamp" || return 1
      docker rm -f "$name" >/dev/null
    fi
  done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cat > "$work/counts.sql" <<'COUNTS'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I;', schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename
\gexec
COMMIT;
COUNTS
cat > "$work/ownership.sql" <<'OWNERS'
SELECT kind, schema_name, object_name, owner_name, acl FROM (
 SELECT 'database' AS kind, '' AS schema_name, datname AS object_name, pg_get_userbyid(datdba) AS owner_name, coalesce(datacl::text,'NULL') AS acl FROM pg_database WHERE datname=current_database()
 UNION ALL SELECT 'schema', nspname, '', pg_get_userbyid(nspowner), coalesce(nspacl::text,'NULL') FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
 UNION ALL SELECT 'relation', n.nspname, c.relname, pg_get_userbyid(c.relowner), coalesce(c.relacl::text,'NULL') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
 UNION ALL SELECT 'function', n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_userbyid(p.proowner), coalesce(p.proacl::text,'NULL') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
 UNION ALL SELECT 'default_acl', coalesce(n.nspname, ''), d.defaclobjtype::text, pg_get_userbyid(d.defaclrole), d.defaclacl::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
) objects ORDER BY kind,schema_name,object_name;
OWNERS
cat > "$work/roles.sql" <<'ROLES'
SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolconnlimit,coalesce(r.rolvaliduntil::text,''),r.rolbypassrls,coalesce(r.rolconfig::text,''),coalesce(a.rolpassword,'') FROM pg_roles r JOIN pg_authid a USING (oid) WHERE left(r.rolname,3) <> 'pg_' AND r.rolname <> 'restore_verifier' ORDER BY r.rolname;
SELECT 'membership', pg_get_userbyid(m.roleid), pg_get_userbyid(m.member), pg_get_userbyid(m.grantor), m.admin_option, coalesce(to_jsonb(m)->>'inherit_option',''), coalesce(to_jsonb(m)->>'set_option','') FROM pg_auth_members m WHERE pg_get_userbyid(m.roleid) <> 'restore_verifier' AND pg_get_userbyid(m.member) <> 'restore_verifier' AND NOT (left(pg_get_userbyid(m.roleid),3) = 'pg_' AND left(pg_get_userbyid(m.member),3) = 'pg_') ORDER BY 2,3,4;
ROLES
for query in counts ownership roles; do
  docker compose exec -T postgres sh -c 'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$POSTGRES_DB"' < "$work/$query.sql" | { if [ "$query" = roles ]; then sha256sum; else cat; fi; } > "$work/source-$query.tsv"
done
printf 'started_at='; date -u +%Y-%m-%dT%H:%M:%SZ
printf 'private_evidence=%s\n' "$work"
printf 'source_app_table_count=%s\n' "$(wc -l < "$work/source-counts.tsv")"
test "$(wc -l < "$work/source-counts.tsv")" -gt 0
timeout --signal=TERM --kill-after=10s 150s docker run --rm -i --name "$pg_name" --label "maintenance.restore=$stamp" --pull never --network none --memory 512m --cpus 0.75 --pids-limit 128 --tmpfs /restore:rw,size=256m --tmpfs /tmp:rw,size=128m \
  --mount "type=bind,src=$backup/database.dump,dst=/input/database.dump,readonly" \
  --mount "type=bind,src=$backup/roles.sql,dst=/input/roles.sql,readonly" \
  --mount "type=bind,src=$work/counts.sql,dst=/input/counts.sql,readonly" \
  --mount "type=bind,src=$work/ownership.sql,dst=/input/ownership.sql,readonly" \
  --mount "type=bind,src=$work/roles.sql,dst=/input/role-query.sql,readonly" \
  -e "RESTORE_DB=$source_db" --entrypoint sh "$pg_image" -s > "$work/postgres-result.txt" 2> "$work/postgres-errors.txt" <<'PG'
set -eu
cp /input/* /tmp/
chown -R postgres:postgres /restore /tmp/database.dump /tmp/roles.sql /tmp/counts.sql /tmp/ownership.sql /tmp/role-query.sql
su postgres -s /bin/bash <<'PGUSER'
set -eu
set -o pipefail
initdb -D /restore --username=restore_verifier -A trust > /tmp/init.log 2>&1
pg_ctl -D /restore -o '-c listen_addresses= -c unix_socket_directories=/tmp' -w start > /tmp/start.log 2>&1
psql -X -q -v ON_ERROR_STOP=1 -h /tmp -U restore_verifier -d postgres -f /tmp/roles.sql > /tmp/roles-restore.log 2>&1
pg_restore --exit-on-error --create -h /tmp -U restore_verifier -d postgres /tmp/database.dump > /tmp/restore.log 2>&1
printf 'BEGIN_COUNTS\n'
psql -X -qAt -v ON_ERROR_STOP=1 -h /tmp -U restore_verifier -d "$RESTORE_DB" -f /tmp/counts.sql
printf 'END_COUNTS\nBEGIN_OWNERSHIP\n'
psql -X -qAt -v ON_ERROR_STOP=1 -h /tmp -U restore_verifier -d "$RESTORE_DB" -f /tmp/ownership.sql
printf 'END_OWNERSHIP\nBEGIN_ROLES\n'
psql -X -qAt -v ON_ERROR_STOP=1 -h /tmp -U restore_verifier -d "$RESTORE_DB" -f /tmp/role-query.sql | sha256sum
printf 'END_ROLES\nBEGIN_ARCHIVE_COUNTS\n'
pg_restore --data-only --file /tmp/source-data.sql /tmp/database.dump
awk '
 /^COPY / { if (active) exit 70; table=$2; gsub(/"/,"",table); if(table !~ /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/) exit 71; active=1; count=0; next }
 active && $0 == "\\." { print table "|" count; active=0; tables++; next }
 active { count++ }
 END { if (active || tables < 1) exit 72 }
' /tmp/source-data.sql > /tmp/archive-counts.tsv
sort /tmp/archive-counts.tsv
printf 'END_ARCHIVE_COUNTS\n'
pg_dump --data-only -h /tmp -U restore_verifier -d "$RESTORE_DB" --file=/tmp/restored-data.sql
for item in source restored; do
  awk '/^COPY / {active=1} active {print} $0 == "\\." {active=0}' /tmp/$item-data.sql > /tmp/$item-copy.sql
done
cmp /tmp/source-copy.sql /tmp/restored-copy.sql
printf 'copy_payload_match=passed\n'
pg_ctl -D /restore -m fast -w stop >/tmp/stop.log 2>&1
printf 'postgres_full_restore=passed\n'
PGUSER
PG
grep -Fx 'postgres_full_restore=passed' "$work/postgres-result.txt"
grep -Fx 'copy_payload_match=passed' "$work/postgres-result.txt"
for section in COUNTS OWNERSHIP ROLES ARCHIVE_COUNTS; do
  awk -v begin="BEGIN_$section" -v end="END_$section" '$0 == begin {active=1; next} $0 == end {active=0; next} active' "$work/postgres-result.txt" > "$work/restored-$section.tsv"
done
cmp "$work/restored-COUNTS.tsv" "$work/restored-ARCHIVE_COUNTS.tsv"
printf 'archive_row_counts_match=passed\n'
printf 'restored_app_rows_begin\n'; cat "$work/restored-COUNTS.tsv"; printf 'restored_app_rows_end\n'
for section in counts ownership roles; do
  upper=$(printf '%s' "$section" | tr '[:lower:]' '[:upper:]')
  if cmp -s "$work/source-$section.tsv" "$work/restored-$upper.tsv"; then
    printf 'current_source_%s_match=true\n' "$section"
  else
    printf 'current_source_%s_match=false\n' "$section"
  fi
done
timeout --signal=TERM --kill-after=10s 150s docker run --rm -i --name "$redis_name" --label "maintenance.restore=$stamp" --pull never --network none --memory 256m --cpus 0.5 --pids-limit 64 --tmpfs /data:rw,size=32m --tmpfs /tmp:rw,size=32m \
  --mount "type=bind,src=$backup/redis.rdb,dst=/input/redis.rdb,readonly" --entrypoint sh "$redis_image" -s > "$work/redis-result.txt" 2> "$work/redis-errors.txt" <<'REDIS'
set -eu
cp /input/redis.rdb /data/dump.rdb
redis-check-rdb /data/dump.rdb > /tmp/rdb-check.log 2>&1
source_keys=$(awk '/keys read/ {print $2}' /tmp/rdb-check.log)
test -n "$source_keys"
redis-server --port 0 --unixsocket /tmp/restore.sock --unixsocketperm 600 --dir /data --dbfilename dump.rdb --appendonly no --save '' --daemonize yes --logfile /tmp/redis.log --pidfile /tmp/redis.pid --hz 1 --dynamic-hz no
attempt=0
until redis-cli -s /tmp/restore.sock ping >/dev/null 2>&1; do
  attempt=$((attempt+1)); test "$attempt" -lt 100; sleep 0.1
done
redis-cli -s /tmp/restore.sock INFO persistence > /tmp/persistence.txt
loaded=$(tr -d '\r' < /tmp/persistence.txt | sed -n 's/^rdb_last_load_keys_loaded://p')
expired=$(tr -d '\r' < /tmp/persistence.txt | sed -n 's/^rdb_last_load_keys_expired://p')
test -n "$loaded"; test -n "$expired"
test "$((loaded + expired))" -eq "$source_keys"
printf 'source_rdb_keys=%s\nloaded_keys=%s\nexpired_at_load=%s\n' "$source_keys" "$loaded" "$expired"
redis-cli -s /tmp/restore.sock INFO keyspace | tr -d '\r'
printf 'redis_full_load=passed\n'
redis-cli -s /tmp/restore.sock SHUTDOWN NOSAVE
REDIS
cat "$work/redis-result.txt"
grep -Fx 'redis_full_load=passed' "$work/redis-result.txt" >/dev/null
for id in "$pg_id" "$redis_id"; do
  test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$id")" = 'true healthy'
done
for name in database.dump roles.sql redis.rdb configuration.tgz; do sha256sum -- "$backup/$name"; done > "$work/input-sha256-after.txt"
cmp "$work/input-sha256.txt" "$work/input-sha256-after.txt"
printf 'finished_at='; date -u +%Y-%m-%dT%H:%M:%SZ
python3 "$script_dir/restore-result.py" "$work"
printf 'full_restore_check=passed\n'
