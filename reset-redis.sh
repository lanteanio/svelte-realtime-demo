#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Flushing Redis..."
docker compose exec -T redis redis-cli FLUSHALL

echo "Done! Redis is empty."
