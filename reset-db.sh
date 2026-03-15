#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Truncating all tables..."
docker compose exec -T postgres psql -U postgres -d stickynotes -c "TRUNCATE note, board CASCADE;"

echo "Done! All tables are empty."
