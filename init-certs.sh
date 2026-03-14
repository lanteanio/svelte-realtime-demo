#!/bin/bash
set -e

DOMAIN=${1:?Usage: ./init-certs.sh <domain> <email>}
EMAIL=${2:?Usage: ./init-certs.sh <domain> <email>}

echo "Obtaining Let's Encrypt certificate for $DOMAIN..."

docker compose run --rm -p 80:80 certbot certonly \
  --standalone \
  --preferred-challenges http \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email

echo ""
echo "Certificate obtained successfully!"
echo "Now run: docker compose up -d"
