#!/bin/bash

# Shared bounded readiness wait for deploy.sh and reset-all.sh. The caller may
# set APP_IMAGE so Compose resolves the same immutable image used for rollout.
wait_for_app_health() {
	local timeout_seconds=${1:-180}
	local expected_replicas=${2:-1}
	local deadline=$((SECONDS + timeout_seconds))
	local ids id running health all_healthy

	while [ "$SECONDS" -lt "$deadline" ]; do
		mapfile -t ids < <(docker compose ps -a -q app)
		all_healthy=1

		if [ "${#ids[@]}" -lt "$expected_replicas" ]; then
			all_healthy=0
		else
			for id in "${ids[@]}"; do
				running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)
				health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id" 2>/dev/null || true)
				if [ "$running" != "true" ] || [ "$health" != "healthy" ]; then
					all_healthy=0
					break
				fi
			done
		fi

		if [ "$all_healthy" -eq 1 ]; then
			return 0
		fi

		sleep 2
	done

	echo "ERROR: expected $expected_replicas healthy app replica(s) within ${timeout_seconds}s." >&2
	docker compose ps app >&2 || true
	return 1
}

wait_for_app_running() {
	local timeout_seconds=${1:-180}
	local expected_replicas=${2:-1}
	local deadline=$((SECONDS + timeout_seconds))
	local ids id running all_running

	while [ "$SECONDS" -lt "$deadline" ]; do
		mapfile -t ids < <(docker compose -f docker-compose.yml -f docker-compose.rollback.yml ps -a -q app)
		all_running=1
		if [ "${#ids[@]}" -ne "$expected_replicas" ]; then
			all_running=0
		else
			for id in "${ids[@]}"; do
				running=$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || true)
				if [ "$running" != "true" ]; then
					all_running=0
					break
				fi
			done
		fi
		[ "$all_running" -eq 0 ] || return 0
		sleep 2
	done

	echo "ERROR: expected $expected_replicas running rollback replica(s) within ${timeout_seconds}s." >&2
	return 1
}
