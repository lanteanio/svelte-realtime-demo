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

# Drop to the node user and run the app. node binds host:443 directly
# under `network_mode: host`; the CAP_NET_BIND_SERVICE file capability is
# set on the node binary in the Dockerfile, and the compose service adds
# the matching `cap_add: NET_BIND_SERVICE` so the cap is available inside
# the container's user namespace. Both halves are required - kernel needs
# the cap surfaced, AND the binary needs the filecaps bit so a non-root
# caller can use it.
exec gosu node node build
