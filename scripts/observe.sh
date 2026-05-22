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
# Columns (CSV-ish, space-separated):
#   t              -- ISO8601 timestamp
#   app2_cpu       -- app-2 container CPU %
#   app2_mem       -- app-2 container memory (MiB)
#   app2_net       -- app-2 net I/O delta since last sample (MB)
#   app3_cpu       -- app-3 container CPU %
#   app3_mem       -- app-3 container memory (MiB)
#   app3_net       -- app-3 net I/O delta since last sample (MB)
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

# Header row.
echo "t                          app2_cpu app2_mem  app2_net  app3_cpu app3_mem  app3_net  ws_est  redis_ops redis_mem  redis_cli pub_rate_top                                stream_subs"

end=$(($(date +%s) + DURATION))

sample() {
  local t app2 app3 stats ws_est redis_info ops cli mem pub_rate top_topic stream_subs metrics

  t=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # docker stats --no-stream is one snapshot per call. Format: CPU% MEM_USAGE NET_IO
  stats=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}} {{.NetIO}}' \
    svelte-realtime-demo-app-2 svelte-realtime-demo-app-3 2>/dev/null)
  app2=$(echo "$stats" | awk '/app-2/ { gsub(/%/,"",$2); printf "%6.1f %7s %9s", $2, $3, $7 }')
  app3=$(echo "$stats" | awk '/app-3/ { gsub(/%/,"",$2); printf "%6.1f %7s %9s", $2, $3, $7 }')

  # TCP connections on the listener port. Sums across both replicas (host networking).
  ws_est=$(ss -tan state established '( sport = :443 )' 2>/dev/null | wc -l)

  # Redis: instantaneous ops/sec + memory + client count
  redis_info=$(docker exec svelte-realtime-demo-redis-1 redis-cli -a "$REDIS_PWD" --no-auth-warning INFO 2>/dev/null)
  ops=$(echo "$redis_info" | awk -F: '/^instantaneous_ops_per_sec:/ { gsub(/\r/,"",$2); print $2 }')
  cli=$(echo "$redis_info" | awk -F: '/^connected_clients:/ { gsub(/\r/,"",$2); print $2 }')
  mem=$(echo "$redis_info" | awk -F: '/^used_memory_human:/ { gsub(/\r/,"",$2); print $2 }')

  # Prometheus: top publisher + active stream subs
  metrics=""
  if [ -n "$TOKEN" ]; then
    metrics=$(curl -sk --max-time 1 -H "X-Scrape-Token: $TOKEN" \
      "https://svelte-realtime-demo.lantean.io/metrics" 2>/dev/null)
  fi
  pub_rate=""
  top_topic=""
  if [ -n "$metrics" ]; then
    pub_rate=$(echo "$metrics" | awk '/^ws_topic_publish_rate\{/ { match($0, /topic="[^"]+"/); t=substr($0, RSTART+7, RLENGTH-8); v=$NF+0; if (v > maxv) { maxv = v; maxt = t } } END { if (maxv > 0) printf "%d %s", maxv, maxt }')
    stream_subs=$(echo "$metrics" | awk '/^svelte_realtime_stream_subscriptions / { print $2 }')
  fi
  pub_rate=${pub_rate:-"-"}
  stream_subs=${stream_subs:-"-"}

  printf "%s  %s  %s  %6s  %9s %9s  %9s  %-40s  %s\n" \
    "$t" "${app2:-       -          -}" "${app3:-       -          -}" \
    "$ws_est" "${ops:-0}" "${mem:--}" "${cli:--}" "${pub_rate:--}" "$stream_subs"
}

while [ "$(date +%s)" -lt "$end" ]; do
  sample
  sleep "$INTERVAL"
done
