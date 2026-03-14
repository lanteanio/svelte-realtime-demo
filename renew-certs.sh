#!/bin/bash
set -e

echo "Renewing certificates..."
docker compose exec certbot certbot renew --standalone

echo "Restarting app to pick up new certs..."
docker compose restart app

echo "Done!"
