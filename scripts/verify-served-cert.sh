#!/bin/sh
set -eu

timeout_seconds=${CERT_SERVE_TIMEOUT_SECONDS:-150}
deadline=$(($(date +%s) + timeout_seconds))
source_der=$(mktemp)
served_der=$(mktemp)
trap 'rm -f "$source_der" "$served_der"' EXIT

openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -outform DER >"$source_der"
source_fingerprint=$(sha256sum "$source_der" | cut -d ' ' -f 1)
served_fingerprint=
serve_host=${CERT_SERVE_HOST:-$DOMAIN}

while [ "$(date +%s)" -lt "$deadline" ]; do
	if timeout 8 openssl s_client -connect "$serve_host:443" -servername "$DOMAIN" </dev/null 2>/dev/null \
		| openssl x509 -outform DER >"$served_der" 2>/dev/null; then
		served_fingerprint=$(sha256sum "$served_der" | cut -d ' ' -f 1)
		if [ "$served_fingerprint" = "$source_fingerprint" ]; then
			echo "Verified: https://$DOMAIN:443 serves the current certificate ($source_fingerprint)."
			exit 0
		fi
	else
		served_fingerprint=
	fi

	sleep 5
done

echo "ERROR: https://$DOMAIN:443 did not serve the volume certificate within ${timeout_seconds}s." >&2
echo "  volume fingerprint: $source_fingerprint" >&2
echo "  served fingerprint: ${served_fingerprint:-unavailable}" >&2
exit 1
