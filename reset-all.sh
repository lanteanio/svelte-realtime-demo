#!/bin/bash
set -e

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
