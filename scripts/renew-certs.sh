#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Renewing certificates..."
docker compose -f docker-compose.yml exec -T certbot certbot renew --standalone

echo "Waiting for the public listener to serve the certificate in the shared volume..."
CERT_SERVE_TIMEOUT_SECONDS=${CERT_SERVE_TIMEOUT_SECONDS:-150}
if ! docker compose -f docker-compose.yml exec -T -e CERT_SERVE_TIMEOUT_SECONDS="$CERT_SERVE_TIMEOUT_SECONDS" \
	certbot sh /usr/local/bin/verify-served-cert; then
	docker compose -f docker-compose.yml ps app >&2 || true
	exit 1
fi
