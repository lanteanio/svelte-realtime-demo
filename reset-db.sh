#!/bin/bash
set -euo pipefail

if [ "${CONFIRM:-}" != "yes" ]; then
	echo "ERROR: This will TRUNCATE every demo table." >&2
	echo "Set CONFIRM=yes to acknowledge and run:" >&2
	echo "  CONFIRM=yes ./reset-db.sh" >&2
	exit 1
fi

cd "$(dirname "$0")"

echo "Truncating all tables..."
docker compose exec -T postgres psql -U postgres -d stickynotes -c \
	"TRUNCATE demos_jobs_tasks, demos_jobs_idempotency, note, board CASCADE;"

echo "Done! All tables are empty."
