#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will FLUSH Redis (every demo board, note, presence record)." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./reset-redis.sh" >&2
	exit 1
fi

cd "$(dirname "$0")"

echo "Flushing Redis..."
docker compose exec -T redis redis-cli FLUSHALL

echo "Done! Redis is empty."
