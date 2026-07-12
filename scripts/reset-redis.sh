#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will FLUSH Redis (every demo board, note, presence record)." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./scripts/reset-redis.sh" >&2
	exit 1
fi

cd "$(dirname "$0")/.."
. scripts/reset-lib.sh

echo "Flushing Redis..."
flush_redis

echo "Done! Redis is empty."
