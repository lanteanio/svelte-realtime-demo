#!/bin/sh
set -e

# Copy SSL certs to a node-readable location. Let's Encrypt artifacts at
# /etc/letsencrypt/live/<domain>/privkey.pem are mode 0600 root, so the
# unprivileged `node` user cannot read them through the volume mount.
# Solve by copying as root, chowning to node, then re-pointing the env
# vars at the copy. Mirrors the pattern shipped in svelte-realtime-docs.
if [ -n "$SSL_CERT" ] && [ -f "$SSL_CERT" ]; then
	mkdir -p /app/certs
	cp "$SSL_CERT" /app/certs/fullchain.pem
	cp "$SSL_KEY" /app/certs/privkey.pem
	chown -R node:node /app/certs
	chmod 600 /app/certs/*.pem
	export SSL_CERT=/app/certs/fullchain.pem
	export SSL_KEY=/app/certs/privkey.pem
fi

# Drop to the node user and run the app. setcap is intentionally absent:
# the demo's docker-compose maps host port 443 to the container's
# non-privileged port 3443, so node never needs to bind to a low port.
exec gosu node node build
