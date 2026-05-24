#!/bin/bash
# observe.sh - server-side diagnostics streamer for e2e / stress runs.
#
# Samples container CPU/mem + WS connection count + Redis ops + Prometheus
# metrics once per INTERVAL seconds and prints one timestamped line per
# sample to stdout. Run it via SSH so each line streams back live:
#
#   ssh root@<box> 'bash ~/svelte-realtime-demo/scripts/observe.sh'
#
# Override sampling rate or duration:
#   ssh root@<box> 'INTERVAL=1 DURATION=600 bash ~/.../scripts/observe.sh'
#
# Stop early with Ctrl-C (script exits and SSH closes).
#
# Replica discovery: runs `docker ps` once at start and samples every
# container whose name matches `svelte-realtime-demo-app-*`. Survives a
# replica-count bump without edits.
#
# Columns (CSV-ish, space-separated):
#   t              -- ISO8601 timestamp
#   <app>_cpu      -- per-container CPU % (one column per replica)
#   <app>_mem      -- per-container memory (MiB) (one column per replica)
#   ws_established -- TCP connections on :443 in ESTABLISHED state
#   redis_ops      -- redis instantaneous_ops_per_sec
#   redis_mem      -- redis used_memory_human
#   redis_clients  -- redis connected_clients
#   pub_rate_top   -- top ws_topic_publish_rate (msg/s) and topic
#   stream_subs    -- svelte_realtime_stream_subscriptions gauge

set -u
INTERVAL=${INTERVAL:-2}
DURATION=${DURATION:-300}

cd ~/svelte-realtime-demo

TOKEN=$(grep ^METRICS_SCRAPE_TOKEN .env 2>/dev/null | cut -d= -f2-)
REDIS_PWD=$(grep ^REDIS_PASSWORD .env 2>/dev/null | cut -d= -f2-)

# Discover every app replica once. Sorted so the column order is stable
# across samples and across runs. Works for any replica count.
mapfile -t REPLICAS < <(
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -E '^svelte-realtime-demo-app-[0-9]+$' \
    | sort -V
)
if [ "${#REPLICAS[@]}" -eq 0 ]; then
  echo "observe: no svelte-realtime-demo-app-N containers running; nothing to sample" >&2
  exit 1
fi

# Header row. CPU+MEM columns per replica, then shared fields.
{
  printf "t                         "
  for c in "${REPLICAS[@]}"; do
    short=${c#svelte-realtime-demo-}  # app-2, app-3, ...
    printf " %6s_cpu %8s_mem" "$short" "$short"
  done
  printf "  ws_est  redis_ops redis_mem  redis_cli pub_rate_top                                stream_subs\n"
}

end=$(($(date +%s) + DURATION))

sample() {
  local t stats ws_est redis_info ops cli mem pub_rate stream_subs metrics
  t=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # docker stats --no-stream is one snapshot per call. Format: NAME CPU% MEM_USAGE NET_IO
  stats=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' \
    "${REPLICAS[@]}" 2>/dev/null)

  # Build per-replica fragments in REPLICAS order so columns line up
  # with the header even if docker stats reordered them.
  local per_replica=""
  for c in "${REPLICAS[@]}"; do
    local cell
    cell=$(echo "$stats" | awk -v name="$c" '
      $1 == name { gsub(/%/,"",$2); printf "%9.1f %12s", $2, $3 }
    ')
    per_replica="$per_replica $cell"
  done

  # TCP connections on the listener port. Host networking means every
  # replica shares the host port (SO_REUSEPORT); this is the cluster total.
  ws_est=$(ss -tan state established '( sport = :443 )' 2>/dev/null | wc -l)

  redis_info=$(docker exec svelte-realtime-demo-redis-1 redis-cli -a "$REDIS_PWD" --no-auth-warning INFO 2>/dev/null)
  ops=$(echo "$redis_info" | awk -F: '/^instantaneous_ops_per_sec:/ { gsub(/\r/,"",$2); print $2 }')
  cli=$(echo "$redis_info" | awk -F: '/^connected_clients:/ { gsub(/\r/,"",$2); print $2 }')
  mem=$(echo "$redis_info" | awk -F: '/^used_memory_human:/ { gsub(/\r/,"",$2); print $2 }')

  metrics=""
  if [ -n "$TOKEN" ]; then
    metrics=$(curl -sk --max-time 1 -H "X-Scrape-Token: $TOKEN" \
      "https://svelte-realtime-demo.lantean.io/metrics" 2>/dev/null)
  fi
  pub_rate=""
  if [ -n "$metrics" ]; then
    pub_rate=$(echo "$metrics" | awk '/^ws_topic_publish_rate\{/ { match($0, /topic="[^"]+"/); t=substr($0, RSTART+7, RLENGTH-8); v=$NF+0; if (v > maxv) { maxv = v; maxt = t } } END { if (maxv > 0) printf "%d %s", maxv, maxt }')
    stream_subs=$(echo "$metrics" | awk '/^svelte_realtime_stream_subscriptions / { print $2 }')
  fi
  pub_rate=${pub_rate:-"-"}
  stream_subs=${stream_subs:-"-"}

  printf "%s %s  %6s  %9s %9s  %9s  %-40s  %s\n" \
    "$t" "$per_replica" \
    "$ws_est" "${ops:-0}" "${mem:--}" "${cli:--}" "${pub_rate:--}" "$stream_subs"
}

while [ "$(date +%s)" -lt "$end" ]; do
  sample
  sleep "$INTERVAL"
done
