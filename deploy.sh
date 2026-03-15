#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Pulling latest changes..."
git pull

echo "Rebuilding and restarting app..."
docker compose up -d --build app

echo "Deployed successfully!"
docker compose logs --tail 5 app
