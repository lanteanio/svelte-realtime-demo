#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will FLUSH Redis and TRUNCATE every demo table." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./reset-all.sh" >&2
	exit 1
fi

cd "$(dirname "$0")"

echo "Stopping app..."
docker compose stop app

echo "Flushing Redis..."
docker compose exec -T redis redis-cli FLUSHALL

echo "Truncating database..."
docker compose exec -T postgres psql -U postgres -d stickynotes -c "TRUNCATE note, board CASCADE;"

echo "Starting app..."
docker compose start app

echo "Done! Clean slate."
