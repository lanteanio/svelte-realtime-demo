#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will FLUSH Redis and TRUNCATE every demo table." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./scripts/reset-all.sh" >&2
	exit 1
fi

cd "$(dirname "$0")/.."
. scripts/compose-health.sh
. scripts/reset-lib.sh

RESET_START_TIMEOUT_SECONDS=${RESET_START_TIMEOUT_SECONDS:-180}
app_was_stopped=0
mapfile -t app_containers_before_reset < <(docker compose ps -a -q app)
expected_app_replicas=${#app_containers_before_reset[@]}

if [ "$expected_app_replicas" -eq 0 ]; then
	echo "ERROR: no app containers exist; refusing a reset with nothing to recover." >&2
	exit 1
fi

restart_app() {
	status=$?
	trap - EXIT

	if [ "$app_was_stopped" -eq 1 ]; then
		echo "Starting app..."
		if docker compose start app; then
			if wait_for_app_health "$RESET_START_TIMEOUT_SECONDS" "$expected_app_replicas"; then
				echo "App is healthy."
				[ "$status" -ne 0 ] || echo "Done! Clean slate."
			else
				echo "ERROR: app did not become healthy after reset." >&2
				[ "$status" -ne 0 ] || status=1
			fi
		else
			echo "ERROR: failed to restart app after reset." >&2
			[ "$status" -ne 0 ] || status=1
		fi
	fi

	exit "$status"
}

# Runs after success, SQL/Redis failure, and interruption. The original
# failure status wins unless recovery itself is the only failing operation.
trap restart_app EXIT

echo "Stopping app..."
app_was_stopped=1
docker compose stop app

echo "Flushing Redis..."
flush_redis

echo "Truncating database..."
truncate_demo_tables
