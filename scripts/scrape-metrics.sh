#!/bin/bash

scrape_metrics() {
  local -a trust=()
  if [ -n "${METRICS_CA_BUNDLE:-}" ]; then
    trust=(--cacert "$METRICS_CA_BUNDLE")
  fi
  if ! curl --disable --fail --silent --show-error --max-time 1 "${trust[@]}" \
    -H "X-Scrape-Token: $2" "$1"; then
    echo 'observe: metrics scrape failed; check connectivity, HTTP status and TLS trust' >&2
    return 1
  fi
}
