#!/bin/sh
set -eu

cert_fingerprint() {
	[ -r "$SSL_CERT_SOURCE" ] && [ -r "$SSL_KEY_SOURCE" ] || return 1
	material_fingerprint=$(sha256sum "$SSL_CERT_SOURCE" "$SSL_KEY_SOURCE" 2>/dev/null) || return 1
	printf '%s' "$material_fingerprint" | sha256sum | cut -d ' ' -f 1
}

watch_certificate() {
	app_pid=$1
	last_fingerprint=$(cert_fingerprint) || return 0
	pending_fingerprint=

	while sleep "${CERT_RELOAD_POLL_SECONDS:-30}"; do
		current_fingerprint=$(cert_fingerprint) || continue

		if [ "$current_fingerprint" = "$last_fingerprint" ]; then
			pending_fingerprint=
			continue
		fi

		# Certbot replaces several files/symlinks during one successful
		# renewal. Require the combined cert+key fingerprint to remain the
		# same across two polls so we never restart onto a half-written pair.
		if [ "$current_fingerprint" != "$pending_fingerprint" ]; then
			pending_fingerprint=$current_fingerprint
			continue
		fi

		jitter_max=${CERT_RELOAD_JITTER_MAX_SECONDS:-30}
		case "$jitter_max" in
			''|*[!0-9]*) jitter_max=30 ;;
		esac
		if [ "$jitter_max" -gt 0 ]; then
			random_value=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
			jitter=$((random_value % (jitter_max + 1)))
		else
			jitter=0
		fi

		echo "[entrypoint] renewed TLS material detected; graceful restart in ${jitter}s"
		sleep "$jitter"
		kill -TERM "$app_pid"
		return 0
	done
}

certificate_watch_enabled=0

# Copy SSL certs to a node-readable location. Let's Encrypt artifacts at
# /etc/letsencrypt/live/<domain>/privkey.pem are mode 0600 root, so the
# unprivileged `node` user cannot read them through the volume mount.
# Solve by copying as root, chowning to node, then re-pointing the env
# vars at the copy. Mirrors the pattern shipped in svelte-realtime-docs.
if [ -n "${SSL_CERT:-}" ] && [ -n "${SSL_KEY:-}" ] \
	&& [ -f "$SSL_CERT" ] && [ -f "$SSL_KEY" ]; then
	export SSL_CERT_SOURCE=$SSL_CERT
	export SSL_KEY_SOURCE=$SSL_KEY
	mkdir -p /app/certs
	cp "$SSL_CERT" /app/certs/fullchain.pem
	cp "$SSL_KEY" /app/certs/privkey.pem
	chown -R node:node /app/certs
	chmod 600 /app/certs/*.pem
	export SSL_CERT=/app/certs/fullchain.pem
	export SSL_KEY=/app/certs/privkey.pem

	certificate_watch_enabled=1
fi

# Drop to the node user and run the app. node binds host:443 directly
# under `network_mode: host`; the CAP_NET_BIND_SERVICE file capability is
# set on the node binary in the Dockerfile, and the compose service adds
# the matching `cap_add: NET_BIND_SERVICE` so the cap is available inside
# the container's user namespace. Both halves are required - kernel needs
# the cap surfaced, AND the binary needs the filecaps bit so a non-root
# caller can use it.
if [ "$#" -gt 0 ]; then
	exec gosu node "$@"
fi

# Keep a minimal root PID-1 supervisor around the unprivileged Node child. It
# reaps the process, forwards Docker stop signals, and lets the root-owned cert
# watcher signal Node directly (Linux may ignore default signals sent to PID 1).
app_pid=
watcher_pid=

shutdown() {
	trap - TERM INT
	[ -z "$watcher_pid" ] || kill -TERM "$watcher_pid" 2>/dev/null || true
	[ -z "$app_pid" ] || kill -TERM "$app_pid" 2>/dev/null || true
	[ -z "$app_pid" ] || wait "$app_pid" 2>/dev/null || true
	exit 0
}

trap shutdown TERM INT

gosu node node build &
app_pid=$!

if [ "$certificate_watch_enabled" -eq 1 ]; then
	watch_certificate "$app_pid" &
	watcher_pid=$!
fi

set +e
wait "$app_pid"
status=$?
set -e

[ -z "$watcher_pid" ] || kill -TERM "$watcher_pid" 2>/dev/null || true
[ -z "$watcher_pid" ] || wait "$watcher_pid" 2>/dev/null || true
exit "$status"
