# Svelte Realtime Demo

A collaborative sticky notes app built with [svelte-realtime](https://github.com/lanteanio/svelte-realtime), [svelte-adapter-uws](https://github.com/lanteanio/svelte-adapter-uws), and [svelte-adapter-uws-extensions](https://github.com/lanteanio/svelte-adapter-uws-extensions).

**Official links:** [GitHub owner](https://github.com/lanteanio) | [Documentation](https://svelte-realtime.dev/) | [Live demo](https://svelte-realtime-demo.lantean.io/) | `svti.me` is the ecosystem-owned runtime-help redirect domain.

Open the page, get a random name, drop notes on a shared canvas. Every note, cursor, and color change syncs across all browsers in real time. No login, no friction.

**Try it now:** [svelte-realtime-demo.lantean.io](https://svelte-realtime-demo.lantean.io/) -- open two tabs and watch the magic.

**Source:** [github.com/lanteanio/svelte-realtime-demo](https://github.com/lanteanio/svelte-realtime-demo)

---

## What it demonstrates

| Feature | Package | How it's used |
|---|---|---|
| `live()` RPC | svelte-realtime | Create, update, delete, and move notes |
| `live.stream()` crud merge | svelte-realtime | Notes on the canvas -- real-time CRUD |
| `live.stream()` set merge | svelte-realtime | Board settings (title, background color) |
| `live.stream()` latest merge | svelte-realtime | Activity ticker -- ephemeral ring buffer |
| `live.cron()` | svelte-realtime | Board cleanup -- delete stale boards every minute |
| `batch()` | svelte-realtime | Coalesce rapid note-drag moves into single WebSocket frames |
| `ctx.batch()` | svelte-realtime | Server-side batched publish for arrangement actions and cron cleanup |
| Optimistic updates | svelte-realtime | Note position updates instantly on drag, server confirms async |
| `status` store | svelte-adapter-uws | Connection status dot in navbar (green/yellow/red) |
| Redis pub/sub bus | extensions | Multi-instance deployment with cross-instance updates |
| Input validation | server | Board titles, note content, colors, and coordinates are validated and bounded |
| Rate limiting | extensions | 100 RPCs per 10 seconds per user (drag/cursor moves are excluded) |
| Presence | extensions | Who's online globally and on each board, with heartbeat + maxAge cleanup |
| Cursors | extensions | Live cursor overlay with per-topic throttle (~60 broadcasts/sec) |
| Cursor snapshots | extensions | Joining users instantly see existing cursor positions |
| Circuit breaker | extensions | Redis failures degrade gracefully instead of blocking |
| Real-time unsubscribe | adapter 0.4.0 | Presence and cursors clean up immediately on page navigation |
| Canvas rendering | demo | 1000 cursors at 60fps via Canvas 2D with bitmap label caching |
| Batch SQL | demo | FAB actions (tidy, rearrange, shuffle, group) use a single query via `unnest()` |
| Board TTL | demo | Boards auto-delete after 1 hour of inactivity, with live countdown timer |
| Mobile support | demo | Touch dragging, responsive navbar, controls visible without hover |

The table above covers the sticky-notes board. Beyond it, the app ships a
gallery of focused demo pages, one per framework primitive.

---

## Demo gallery

Every page lives at `/demos/<slug>`, backed by one module in
`src/live/demos/` and one Playwright spec in `test/e2e/`.

| Route | What it shows |
|---|---|
| `checkout` | Idempotency under a retry storm |
| `counter-resume` | Reconnect-resume with no flicker |
| `chat` | Chat rooms with presence + denials |
| `todos-rollback` | Optimistic mutate with rollback |
| `denials` | Subscribe denials with org switcher |
| `pressure` | Admission-shedding control panel |
| `chaos` | Deterministic chaos (seeded drop rate) |
| `notifications` | Push, reply, schedule |
| `topk` | Top-K leaderboards: four windows, one config |
| `news` | Cron + windowed aggregate + derived + inbound webhook |
| `jobs` | Durable task runner with fence + retry |
| `cluster-cron` | Leader election: one leader, one tick |
| `upload` | Streaming uploads with content-addressed dedup |
| `auctions` | Deadline-bounded bid race over live.push |
| `schema-evolution` | Subscribe-time migrate hooks |
| `flash-sales` | Atomic inventory under contention (live.lock) |
| `pagination` | Cursor-based load-more with live merges |
| `effect` | Server-side reactive side effects |
| `from-seq` | Three-tier reconnect gap fill |
| `collab-editor` | CRDT-anchored selections vs raw offsets |
| `multiplayer` | Full-surface room: cursors, locks, typing, reactions |
| `kanban` | Shared CRDT document, zero RPC handlers |
| `offline` | Offline queue: post now, sync later, replay once |
| `arena` | Area-of-interest culling with LOD bands |
| `shooter` | Lag-compensated hit testing |
| `lobbies` | Room browser, ownership, share codes |
| `tenants` | Strict per-connection tenant isolation |
| `flags` | Feature flags: flip once, everywhere |
| `alarms` | Durable one-shot timers that survive restarts |
| `forget` | Right to erasure: one call, every surface |
| `privacy` | k-anonymity + differential privacy aggregates |
| `ops` | The introspection dashboard |
| `outbound-webhooks` | Sign, retry, dead-letter, replay |
| `phases` | Attach lifecycle + atomic publish batch |

News and Top-K controls pair each Redis write with an atomic revision. Their
pages ignore older stream revisions and reconcile notifications with serialized
snapshot RPCs. A cold load or reconnect reads each control once: two reads for
Top-K, one for News. Returning by client-side navigation within the ten-minute
stream resume window reads each control twice, for the retained value and then
the resumed snapshot: four reads for Top-K, two for News. Each notification burst
also reads the notified control; a notification during a read triggers another
read after it finishes. This recovers writes hidden by browser frame batching
and rebases the page's revision baseline after Redis resets, without reloading.

---

## Board lifecycle

Board names wrap visibly at narrow widths. Use the Rename board button or double-click the title to edit it; Enter saves. The canvas fills the space between the board header and activity bar, so wrapping controls do not push its bottom below the viewport.

Undo restores notes you deleted within the last 30 seconds, for every visitor. Use the deletion toast or Ctrl/Cmd+Z outside text fields; recent deletions are available again after reload. Each restore is accepted once and never replaces an existing note. Creating, editing, moving and arranging notes are excluded, and there is no redo. Deletion snapshots expire after 30 seconds and are removed by a minute cleanup task. PostgreSQL deployments require migration `004_note_deletion_undo.sql` before starting the new app.

Boards are ephemeral by design. Every board starts with a 1-hour countdown. Any meaningful action (create/edit/delete a note, change settings, run an arrangement) resets the timer. Boards with no activity for 1 hour are deleted automatically by a server-side cron job.

The `stress-me-out` board is exempt -- it's auto-created on startup and never expires. The E2E stress tests use it.

Countdown timers are visible on every board card (home page) and in the board header. They use the DaisyUI countdown component and change color as the deadline approaches: neutral > 10 min, warning 5-10 min, error < 5 min.

---

## Performance

Stress-tested with 1000 simultaneous bot users on a single board, all moving cursors.

| Metric | Result |
|---|---|
| Connections | 1000/1000 (100%) |
| Connect time | ~8 seconds |
| FPS (1000 cursors) | 60 |
| p50 frame time | 16.7ms |
| p95 frame time | 18.0ms |
| JS heap | 9.5 MB |
| Server responsive | Yes |

Key optimizations:
- **Canvas 2D** instead of SVG for cursors (zero DOM diffing per frame)
- **Bitmap label cache** -- user names rendered to offscreen canvases once, then `drawImage()` per frame
- **rAF cursor throttle** -- outbound cursor moves coalesced to one per animation frame
- **Per-topic broadcast budget** -- server caps cursor broadcasts at ~60/sec per board regardless of user count
- **RAF event batching** -- incoming WebSocket events coalesced into one Svelte store update per frame
- **Batched publish** -- arrangement actions publish all note updates + activity in a single `ctx.batch()` call instead of N+1 individual publishes
- **Batch SQL** -- arrangement actions update all notes in a single `unnest()` query instead of N+1
- **Direct DOM drag** -- note dragging bypasses Svelte reactivity during the drag for smooth touch performance
- **Delayed handoff** -- local drag position held for 300ms after release to avoid snap-back jitter

For OS-level tuning (sysctl, ulimits, conntrack), see the [svelte-adapter-uws production docs](https://github.com/lanteanio/svelte-adapter-uws#os-tuning-for-production).

---

## Tech stack

- **Frontend** -- SvelteKit, Svelte 5 (runes), Tailwind CSS v4, DaisyUI v5
- **Server** -- svelte-adapter-uws (uWebSockets.js)
- **Realtime** -- svelte-realtime (RPC + live streams over WebSocket)
- **Extensions** -- svelte-adapter-uws-extensions (Redis-backed presence, cursors, pub/sub, rate limiting, circuit breaker)
- **Database** -- PostgreSQL (production) / in-memory Map (dev)
- **Cache & pub/sub** -- Redis (production) / not needed (dev)

---

## Getting started

### Prerequisites

- Node.js 22.19+ (the highest direct-dependency floor, enforced by
  `package.json` and exercised in CI)
- Docker (for Postgres and Redis, or bring your own)

### Install

```bash
npm ci
```

### Configure

Copy the example env file:

```bash
cp .env.example .env
```

The defaults point at `localhost` which works if Postgres and Redis are running in Docker on standard ports.

### Create or upgrade the database

The same checksummed migration path handles an empty database and every
upgrade. Run it before starting a new application revision:

```bash
npm run migrate
```

### Dev mode

```bash
npm run dev
```

If `DATABASE_URL` is not set, the app falls back to an in-memory store. You can develop without Postgres or Redis -- all realtime features still work locally, just not across multiple server instances.

### Production build

```bash
npm run build
npm start
```

### Deploy with Docker Compose

The included `docker-compose.yml` sets up everything: app, Postgres, Redis, and a certbot container for automatic Let's Encrypt TLS. HTTPS out of the box, no reverse proxy.

The app runs as 4 independent replicas by default using `network_mode: host`
and `SO_REUSEPORT`. The Linux kernel distributes incoming connections across
the processes. Redis handles cross-process pub/sub.

1. Point a domain at your server (A record)
2. Create a `.env` file:

```bash
DOMAIN=your-domain.com
POSTGRES_PASSWORD=pick-a-strong-password
STICKYNOTES_APP_PASSWORD=pick-a-different-strong-password
DEMO_NEWS_WEBHOOK_SECRET=generate-a-long-random-secret
```

3. Get the initial certificate. The explicit entrypoint is required because
   the long-running certbot service itself uses a shell renewal loop:

```bash
docker compose run --rm --entrypoint certbot -p 80:80 certbot certonly --standalone -d your-domain.com
```

4. Start everything:

```bash
docker compose up -d
```

The `migrate` service completes before any app replica is allowed to start.
The app listens on port 443 directly (host networking). Certbot checks for
renewals every 12 hours. Running replicas fingerprint the read-only source
certificate and key; after a renewed pair is stable, they restart gracefully
with independent jitter and copy the new material before accepting traffic.
Postgres and Redis data are persisted in Docker volumes.

For production updates, use `./scripts/deploy.sh`. It requires a clean checkout, builds
an image tagged with the exact Git revision, runs migrations, waits for every
replica's dependency-aware `/healthz` check, verifies the public page and
WebSocket upgrade, and restores the previous image automatically if readiness
or smoke verification fails.

To scale replicas:

```bash
docker compose up -d --scale app=4
```


### Maintenance restart

A host restart interrupts all app replicas, Postgres and Redis together. Reserve
an outage window with the operator before restarting for installed kernel or
system-library updates. These steps run in Bash on the Linux deployment host,
from its existing checkout. Record the chosen host, window, expected downtime,
operator and recovery deadline in the private maintenance record.

Before requesting execution approval:

1. Confirm provider-console access works for this host and identify the person
   who can use it if SSH does not return. Confirm how to select the previously
   working installed kernel in its boot menu. Do not assume console access or a
   usable previous kernel is available.
2. Verify the backup record: Postgres backup time and location, Redis persistence
   and backup coverage, and recoverable deployment configuration and certificates.
   Confirm the required recovery point and the last successful restore check.
   Docker volumes alone are persistence, not a backup. If recovery evidence is
   missing, stop and arrange backup/restore preparation before the outage.
3. Capture the current kernel, pending restart markers, installed boot files,
   service state, volume names, replica count and immutable image identities.
   Keep this inventory private; do not print container environment variables or
   `.env` contents. Confirm the expected next kernel from the installed boot
   configuration; the restart marker alone does not identify what will boot.

```bash
uname -r
uptime
systemctl --failed
systemctl is-enabled docker
systemctl is-active docker
if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required; fi
if [ -f /var/run/reboot-required.pkgs ]; then cat /var/run/reboot-required.pkgs; fi
ls -l /boot/vmlinuz-* /boot/initrd.img-*
git rev-parse HEAD
git status --short
docker compose ps -a
for id in $(docker compose ps -a -q app postgres redis certbot); do
  docker inspect --format '{{.Name}} image={{.Config.Image}} digest={{.Image}} restart={{.HostConfig.RestartPolicy.Name}} running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id"
  docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$id"
done
```

Record the healthy running app count and image digest before proceeding; mixed
images or an unhealthy baseline need investigation first. Confirm the containers'
restart policies and Docker boot enablement will bring the existing stack back.
Keep the current image locally available. Save a private, persistent baseline on
the host before the restart. Set `MAINT_RECORD_DIR` to a new absolute directory
outside temporary storage, `MAINT_EXPECTED_REPLICAS` to the healthy app count and
`MAINT_EXPECTED_KERNEL` to the installed kernel selected for the next boot:

```bash
(
  set -euo pipefail
  umask 077
  : "${MAINT_RECORD_DIR:?set a new private persistent record directory}"
  : "${MAINT_EXPECTED_REPLICAS:?set the healthy app replica count}"
  : "${MAINT_EXPECTED_KERNEL:?set the planned next kernel}"
  [[ "$MAINT_RECORD_DIR" == /* && ! -e "$MAINT_RECORD_DIR" ]]
  [[ "$MAINT_EXPECTED_REPLICAS" =~ ^[1-9][0-9]*$ ]]
  test -f "/boot/vmlinuz-$MAINT_EXPECTED_KERNEL"
  test -f "/boot/initrd.img-$MAINT_EXPECTED_KERNEL"
  systemctl is-enabled --quiet docker
  systemctl is-active --quiet docker
  maintenance_failed=$(systemctl --failed --no-legend --plain)
  test -z "$maintenance_failed"
  mkdir -m 700 "$MAINT_RECORD_DIR"
  git rev-parse HEAD > "$MAINT_RECORD_DIR/source"
  printf '%s\n' "$MAINT_EXPECTED_KERNEL" > "$MAINT_RECORD_DIR/kernel"
  printf '%s\n' "$MAINT_EXPECTED_REPLICAS" > "$MAINT_RECORD_DIR/replicas"
  maintenance_ids=$(docker compose ps -a -q app postgres redis)
  mapfile -t maintenance_health_ids <<< "$maintenance_ids"
  test "${#maintenance_health_ids[@]}" -eq "$((MAINT_EXPECTED_REPLICAS + 2))"
  for id in "${maintenance_health_ids[@]}"; do
    test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$id")" = 'true healthy'
  done
  test "$(docker compose ps -a -q app | wc -l)" -eq "$MAINT_EXPECTED_REPLICAS"
  maintenance_app_ids=$(docker compose ps -a -q app)
  maintenance_app_images=$(for id in $maintenance_app_ids; do docker inspect --format '{{.Image}}' "$id"; done | sort -u)
  test "$(printf '%s\n' "$maintenance_app_images" | wc -l)" -eq 1
  for service in postgres redis certbot; do
    test "$(docker compose ps -a -q "$service" | wc -l)" -eq 1
  done
  test "$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -a -q certbot)")" = true
  maintenance_ids=$(docker compose ps -a -q app postgres redis certbot)
  for id in $maintenance_ids; do
    docker inspect --format '{{.Id}} {{.Image}}' "$id"
  done | sort > "$MAINT_RECORD_DIR/images"
)
```

Keep the successful baseline directory path in the private maintenance record;
a failed capture is incomplete and must not be used. A maintenance restart uses existing
containers; `scripts/deploy.sh` pulls source, builds, migrates and recreates app
replicas, so it is a separate deployment procedure.

The operator must explicitly approve the named host, outage window, recovery
plan and restart after reviewing this inventory. Only inside that approved
window, with console access ready and no deployment or data migration running,
start the following monitor on a separate external machine with Node and this
checkout. Set the confirmed public HTTPS origin and a new private output path:

```bash
node scripts/maintenance-monitor.mjs https://your-domain.example /private/path/readiness.json
```

Wait for the private capture to show successful `/readyz` samples before issuing
the restart. Keep the monitor running through SSH reconnects and failed host
postflight attempts; it is independent of those commands. It records every probe
start/end time and failure, saves after each sample, and stops after 30 minutes
with a non-success outcome if recovery is not completed. If the capture misses
the restart, do not restart again just to measure it. Then, on the approved
host:

```bash
sudo systemctl reboot
```

After SSH returns, compare `uname -r` with the planned kernel, review boot
errors, and require the restart marker to be absent. Keep raw journal output
private and redact sensitive content before sharing it. If the marker is still
there, find out why instead of deleting it. From the same checkout, set
`MAINT_RECORD_DIR` to the successful baseline directory and `MAINT_BASE_URL` to
the confirmed public HTTPS origin. Docker can still be activating after SSH
returns, so wait for it before checking the existing containers. The following
checks fail on any failed unit, wrong kernel/source/image, missing container or
unhealthy dependency:

```bash
(
  set -euo pipefail
  umask 077
  : "${MAINT_RECORD_DIR:?set the successful baseline directory}"
  : "${MAINT_BASE_URL:?set the confirmed public HTTPS origin}"
  test -d "$MAINT_RECORD_DIR"
  test "$(uname -r)" = "$(cat "$MAINT_RECORD_DIR/kernel")"
  test "$(git rev-parse HEAD)" = "$(cat "$MAINT_RECORD_DIR/source")"
  MAINT_EXPECTED_REPLICAS=$(cat "$MAINT_RECORD_DIR/replicas")
  [[ "$MAINT_EXPECTED_REPLICAS" =~ ^[1-9][0-9]*$ ]]
  [[ "$MAINT_BASE_URL" == https://* ]]
  maintenance_deadline=$((SECONDS + 120))
  until systemctl is-active --quiet docker; do
    test "$SECONDS" -lt "$maintenance_deadline"
    sleep 2
  done
  systemctl is-enabled --quiet docker
  maintenance_failed=$(systemctl --failed --no-legend --plain)
  test -z "$maintenance_failed"
  journalctl -b -p err --no-pager
  test ! -e /var/run/reboot-required
  . scripts/compose-health.sh
  wait_for_app_health 180 "$MAINT_EXPECTED_REPLICAS"
  test "$(docker compose ps -a -q app | wc -l)" -eq "$MAINT_EXPECTED_REPLICAS"
  for service in postgres redis; do
    maintenance_ids=$(docker compose ps -a -q "$service")
    test -n "$maintenance_ids"
    mapfile -t maintenance_service_ids <<< "$maintenance_ids"
    test "${#maintenance_service_ids[@]}" -eq 1
    maintenance_deadline=$((SECONDS + 120))
    until test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' "$maintenance_ids")" = 'true healthy'; do
      test "$SECONDS" -lt "$maintenance_deadline"
      sleep 2
    done
  done
  test "$(docker compose ps -a -q certbot | wc -l)" -eq 1
  test "$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -a -q certbot)")" = true
  maintenance_ids=$(docker compose ps -a -q app postgres redis certbot)
  for id in $maintenance_ids; do
    docker inspect --format '{{.Id}} {{.Image}}' "$id"
  done | sort > "$MAINT_RECORD_DIR/images-after"
  cmp "$MAINT_RECORD_DIR/images" "$MAINT_RECORD_DIR/images-after"
  maintenance_failed=$(systemctl --failed --no-legend --plain)
  test -z "$maintenance_failed"
  curl --fail --silent --show-error --max-time 10 "$MAINT_BASE_URL/healthz"
  curl --fail --silent --show-error --max-time 10 "$MAINT_BASE_URL/readyz"
)
```

The subshell must exit successfully, and the boot journal must be reviewed,
before pressing Enter in the still-running external monitor. Enter runs
`scripts/deployment-smoke.mjs`; a failed smoke keeps readiness sampling active
and permits another Enter after investigation. A successful smoke and another
successful `/readyz` probe are both required to finish the capture.

The smoke requires `/healthz` and the homepage to return 200, validates TLS
using Node's normal certificate checks, then requires a valid `/ws` upgrade with
the matching Origin and Sec-WebSocket-Accept. It closes that socket immediately;
it does not verify application subscriptions or reach every replica. The local
container health/count checks cover replicas separately. Record the observed
kernel, cleared restart state, service health, image comparison and external
smoke results before ending the maintenance window. Report the capture's last
successful, first failed, last failed and first recovered probe timestamps.
Outage windows come from sampled probe starts, so they bound the outage rather
than time it exactly. A capture that was interrupted or hit its deadline does
not show recovery; report the missing period as missing instead of estimating
it.

If the host misses the agreed recovery deadline or boots the wrong kernel, use
the provider console and the recorded boot recovery procedure. Select the
previously working installed kernel when appropriate; preserve boot error
messages and reassess the update before another attempt. Do not remove kernels
or restore data speculatively. If the host boots but dependencies or the app do
not recover, inspect service/container logs first. An app-image rollback cannot
repair a failed kernel boot or restore a database. The automatic app rollback in
`scripts/deploy.sh` applies to its own deployment attempt; it is not invoked by
this restart and must not be used as an unattended host-recovery action.

---

## Host sampling

Use bounded, read-only observations for an on-demand review of the demo
deployment. Identify the host, observation window and private evidence location
before running commands. Record UTC start/end times, kernel, CPU count, RAM,
application image IDs and replica count with each window. Keep credentials,
peer addresses, board names and user content out of the evidence; do not export
environment files, full container inspection output or raw application logs.

Use available history first. When fresh measurements would answer a concrete
question, take a five-minute window and, when useful, a comparable window under
different traffic. Record aggregate traffic beside resource measurements. Only
call a window high or low traffic after comparing it with the other; the time of
day is not enough. If traffic is flat or absent, say so; do not generate load to
create a peak. Repeat a check when investigating a problem or after a
deployment, capacity, security or network change. A running collection timer
only means samples exist, not that anyone has read them.

When sysstat already collects periodic history, retain that history and use the
same instrument for later comparisons. On the host, extract the available daily
files with the original sample intervals into a private directory:

```bash
set -o pipefail
umask 077
report=$(mktemp -d "${TMPDIR:-/tmp}/host-sysstat.XXXXXXXX") || exit
failed=0
for file in /var/log/sysstat/sa[0-9][0-9]; do
  test -f "$file" || continue
  name=$(basename "$file")
  if sadf -j "$file" -- -u -r -q -d -n DEV,EDEV,TCP,ETCP > "$report/$name.json"; then
    printf '%s exit=0\n' "$name"
  else
    status=$?
    failed=1
    printf '%s exit=%s incomplete=%s\n' "$name" "$status" "$report/$name.json"
  fi
done
printf 'private_capture=%s\n' "$report"
test "$failed" -eq 0
```

Check the date inside each file before selecting the review period; daily file
names are reused each month. Leave out the current day when comparing completed
days. Reject incomplete files, keep the interval durations and weight aggregate
means by them. Compare matching interfaces and devices, and treat restarts and
counter resets separately. Take each day's traffic high and low from the
physical interface and keep every tied timestamp. A high sample in a quiet week
is not representative peak demand; if the traffic never shows a real peak, write
that down. Ten-minute history and five-minute live windows are separate series:
keep both and do not compare one against the other.

On the Linux host, from the deployment checkout, record this compact inventory
at the start and end of each window. Execute the commands individually in a
Bash shell with `set -o pipefail`; immediately after each command or pipeline,
append `printf 'exit=%s\n' "$?"` to the private capture before running the next
command. This includes each sampler and external check below. A numeric line
from a failed pipeline must not be treated as a valid sample.

```bash
set -o pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
uname -r
nproc
uptime
free -m
df -h / /var/lib/docker
df -i / /var/lib/docker
docker compose ps --format json
docker compose ps -q app | xargs -r docker inspect --format '{{.Name}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}}'
ss -Htan state established '( sport = :443 )' | wc -l
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io
cat /proc/net/dev
date -u +%Y-%m-%dT%H:%M:%SZ
```

Retain each command's exit status; unavailable counters and permission failures
are missing measurements, not zero values. `/proc/net/dev` contains interface
totals, not peer addresses. Compare byte, packet, error and drop deltas over the
recorded elapsed time, keeping interfaces separate and accounting for resets.
The headerless `ss` count includes all established HTTPS connections, not only
WebSockets or distinct people. Compare equivalent windows on the same topology;
do not use that count as a useful-work total. Linux [pressure counters](https://docs.kernel.org/accounting/psi.html)
report stall percentages over 10/60/300 seconds and cumulative microseconds;
compare cumulative deltas for the recorded window. Use CPU `some`, since
system-level CPU `full` is undefined and its compatibility zero is not evidence
of no contention.

During each window, run these bounded samplers in separate host terminals so
their timestamps overlap. `iostat` requires an existing sysstat installation;
record its absence rather than installing packages as part of observation.
Use the same command/exit-status capture in each terminal.

```bash
TZ=UTC vmstat -w -t 5 61
```

```bash
TZ=UTC iostat -xz -t 5 61
```

Discard the first vmstat/iostat report, which summarizes time since boot.
At the start, midpoint and end of the window, capture container usage and
aggregate connections with:

```bash
set -o pipefail
date -u +%Y-%m-%dT%H:%M:%SZ
docker compose ps -q app postgres redis | xargs -r docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'
ss -Htan state established '( sport = :443 )' | wc -l
date -u +%Y-%m-%dT%H:%M:%SZ
```

CPU utilization, runnable/blocked work, swap activity and pressure counters
separate resource use from contention; device latency/queues and interface
error/drop deltas add storage and network context. Compare device utilization
with its actual capacity, and retain kernel/device error counts from the
approved monitoring system. Low CPU or a healthy container on its own does not
mean the host is healthy.

`scripts/observe.sh` remains a supplementary stress-run streamer. Its listener
metrics scrape can reach a different worker on each request under SO_REUSEPORT:
do not sum those samples or subtract successive counter values as fleet totals.
Use consistent per-worker collection with instance identity and reset handling
when calculating application rates. The host commands above do not scrape
application metrics or read credentials.

For an on-demand access and exposure check, record service states with
`systemctl --failed` and `systemctl is-active ssh docker unattended-upgrades`;
record installed/running kernel versions and `/var/run/reboot-required.pkgs`
when present. Inspect effective SSH authentication settings, privileged account
and authorized-key inventory, listening service bindings, host firewall policy
and the provider firewall policy through available authorized access. Keep only
policy decisions, aggregate counts and service bindings in the report; do not
export keys, login histories or raw logs. If a policy source cannot be reached,
record it as unknown instead of guessing. Compare allowed ports and identities
against the intended deployment, and make any changes as a separate step after
the check.

At each window's start and end, use an external workstation to run
`node scripts/deployment-smoke.mjs https://svelte-realtime-demo.lantean.io`
and check `/readyz` over HTTPS with normal certificate verification. Timestamp
the result and record failures alongside internal container readiness. The
smoke checks `/healthz`, the public page and the WebSocket upgrade; it opens a
short connection but does not create board data. Internal Unix-socket health
and the public TLS path are separate observations.

Keep the private report structured as: window metadata and traffic context;
per-resource utilization, saturation and errors; service/patch/access/exposure
state; external readiness; comparison with any matched window; missing data; and
what the review concluded. Store raw numeric samples alongside the summary so
the comparisons can be reproduced.

---

## E2E tests

Playwright tests covering:

- Board CRUD, note operations (create, edit, drag, delete, color, z-order)
- Board settings (title, background), persistence across refresh
- FAB menu (tidy, rearrange by color, shuffle, group by author)
- Collaborative deletion undo: actor-scoped receipts, second-visitor convergence, reload, expiry and replay protection
- Multi-user realtime sync (two browser contexts)
- Presence and cursor overlay
- Activity ticker
- Identity system and theme toggle
- Input validation (empty/long titles, XSS, invalid slugs)
- WebSocket connection leak detection
- Performance metrics (TTFB, FCP, CLS, resource sizes)
- Mobile touch (drag, double-tap create, controls visible, responsive nav)
- One spec per demo page (every entry in the demo gallery above)
- 1000-user cursor stress test
- Presence-only destroyer (ramp to 10K, find the connection ceiling)
- Cursor destroyer (ramp with live cursor movement)

```bash
# Everyday verification: static checks, unit tests, build, then safe E2E
npm test

# Individual E2E tiers (each provisions isolated Postgres/Redis + local app)
npm run test:e2e:isolated
npm run test:e2e:cluster
npm run test:e2e:stress
npm run test:e2e:diagnostics
npm run test:e2e:destroyer

# Explicit expensive ladder: safe + cluster + stress + 10K destroyer
# Continues through failures and prints an aggregate result.
npm run test:all
```

CI runs the safe verification gate and the complete functional cluster tier as separate jobs on every push and pull request. The cluster job starts four replicas, fails on any assertion failure, and retains failed-test traces, screenshots, videos and the HTML report for 14 days as the `cluster-failure-evidence` artifact. Its timeout is 35 minutes.

Set `E2E_CLUSTER_REPLICAS=4` when running the cluster or diagnostics tier to start four isolated app processes (the default is two). The arena four-replica spec checks explicit interest-exit removals and re-entry on each process, using distinct loopback origins. It also checks that the received set stays bounded after panning. This exercises the shared Redis authority and relay topology; it does not emulate Linux SO_REUSEPORT socket distribution.

The normal target is always a dynamically allocated loopback port. Diagnostic `_*.spec.js` probes run only in the explicit diagnostics project, including probes whose filenames end in `.cluster.spec.js`. Select one with `npm run test:e2e:diagnostics -- _mp-cursor-trailing-probe.cluster.spec.js`; the harness supplies separate replica targets. Functional cluster assertions remain in the cluster gate, including `cluster-probe.spec.js` and `cluster-bugs-probe.spec.js`. To point a low-level Playwright command at a remote test environment, set both `BASE_URL` and `ALLOW_REMOTE_E2E=1`; without that opt-in the configuration refuses any non-loopback host. Never enable the opt-in for production.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | _(none)_ | Postgres connection string. When unset, uses in-memory store. |
| `DATABASE_POOL_MAX` | `10` | Maximum shared PostgreSQL connections per app process (4 replicas = at most 40). |
| `DATABASE_CONNECT_TIMEOUT_MS` | `2000` | Bounded PostgreSQL connection wait. |
| `REDIS_URL` | `redis://localhost:6379` | Redis for pub/sub, presence, cursors, and rate limiting. |
| `REDIS_SESSION_TIMEOUT_MS` | `1000` | Per-operation identity-session budget before ephemeral fallback. |
| `READINESS_TIMEOUT_MS` | `2500` | Per-dependency readiness budget. |
| `ADMIN_TOKEN` | _(none)_ | Bearer token for the `/__realtime/*` admin plane (introspect, DLQ inspect + replay, lifeline metrics). Unset = every admin request is denied. |
| `DEMO_NEWS_WEBHOOK_SECRET` | _(dev fallback)_ | HMAC secret for the inbound newsroom webhook. Required in production. |
| `HOST` | `0.0.0.0` | Server bind address. |
| `PORT` | `3000` | Server port. |
| `ORIGIN` | _(none)_ | The deployment's canonical public origin, e.g. `https://example.com`. When set it is the authority for WebSocket admission: a handshake whose `Origin` does not match is refused with 403, a handshake carrying no `Origin` is refused with 401, and a request whose `Host` is neither this name nor a loopback name is refused with 400. Unset (a bare checkout) leaves all three inert. The compose file derives it from `DOMAIN`. |
| `ALLOWED_ORIGINS` | _(none)_ | **Build-time.** Comma-separated extra origins for a deployment reachable under more than one name, e.g. `https://example.com,https://www.example.com`. Read when the bundle is built, not when the container starts. A single-hostname deployment leaves this unset and relies on `ORIGIN`. |
| `WS_ALLOW_ORIGINLESS` | _(none)_ | Set to `1` to re-admit WebSocket handshakes that carry no `Origin` header on a deployment that has `ORIGIN` set. Browsers always send `Origin`, so this is only for non-browser clients. |
| `BUILD_OUT_DIR` | `build` | **Build-time.** Where the built server is written. The e2e harness sets it per run so a concurrent build in the same checkout cannot rewrite the tree a live run is serving from; deployments leave it alone. |

---

## Project structure

```
scripts/                            -- build, migrate, deploy, cert + reset helpers, test runners
migrations/                         -- ordered, checksummed SQL (see Database)
test/
├── e2e/                            -- Playwright specs: board app + one per demo page
└── unit/                           -- unit tests (run via scripts/run-unit.mjs)
src/
├── hooks.ws.js                     -- WebSocket lifecycle: identity, presence, cursors,
│                                      tenant resolver, admin plane, coordinator wiring
├── hooks.server.js                 -- Stress-board bootstrap, Host check, framing header,
│                                      error handler
├── app.html                        -- HTML shell with Svelte favicon
├── app.css                         -- Tailwind + DaisyUI setup
├── routes/
│   ├── +layout.svelte              -- Navbar, connection status, 'outdated bundle' reload banner
│   ├── +layout.server.js           -- Identity cookie: read or generate
│   ├── +page.svelte                -- Home: board list + searchable demo catalog
│   ├── board/[slug]/               -- The sticky-notes board (canvas, FAB menu)
│   ├── demos/                      -- One page per demo, shared sidebar layout
│   ├── api/demos/                  -- Webhook sink + inbound news webhook + org/tenant switchers
│   ├── healthz/                    -- Dependency-aware health (readiness is the adapter's /readyz)
│   └── metrics/                    -- Prometheus-style metrics
├── lib/
│   ├── names.js                    -- Random name/color/slug generator
│   ├── configure-app.js            -- App-wide realtime client options, merged under page options
│   ├── protocol-version.js         -- Shared wire/contract version (server + client)
│   ├── server/
│   │   ├── db.js                   -- Postgres + in-memory (touch, delete, stale cleanup)
│   │   ├── redis.js                -- Redis client, pub/sub bus, coordinators (CRDT, smooth,
│   │   │                              alarms, dead-letter, webhook controls), presence, breaker
│   │   ├── topics.js               -- Topic registry: single source of truth for every topic
│   │   ├── demo-purge.js           -- Cron purge of demo user-content
│   │   ├── tasks.js                -- Durable task runner (jobs demo)
│   │   ├── validate.js             -- Input validation (UUID, bounds, allowlist)
│   │   └── ...                     -- identity sessions, readiness, metrics, upload staging
│   └── components/                 -- Board UI (StickyNote, Canvas, CursorOverlay, ...)
└── live/
    ├── boards.js + boards/         -- Board CRUD, notes, activity, settings, cursors
    └── demos/                      -- One module per demo page; game demos add pure
                                       .shared.js sim modules shared client/server
```

---

## Admin plane and probes

- `/healthz` is the app's dependency-aware health check (Postgres, Redis,
  identity store). The adapter's built-in health route is disabled
  (`healthCheckPath: false` in `svelte.config.js`) so it cannot shadow it.
- `/readyz` is the adapter's readiness probe. The maintenance restart checks it
  separately; deployment and Compose healthchecks gate on `/healthz`.
- `/__realtime/*` is the fail-closed admin plane (introspect snapshot, DLQ
  inspect + replay, lifeline metrics). Requests need `Authorization: Bearer
  $ADMIN_TOKEN`; with `ADMIN_TOKEN` unset every request is denied. The
  `/demos/ops` page renders the same introspect snapshot over the socket.

---

## Database

The canonical schema is the ordered, checksummed SQL under `migrations/`.
It contains the `board` and `note` application tables, the durable jobs-demo
tables, validation-mirroring constraints, measured query indexes, and the
auto-archive function. `scripts/migrate.mjs` serializes migration runners and
records applied checksums in `schema_migration`.

---

## How identity works

No login. Every visitor gets a random two-word name (like "Cosmic Penguin")
and a random color. An opaque 128-bit session id is held in a `Secure`,
`SameSite=Lax`, `HttpOnly` cookie; the identity itself lives in Redis with a
30-day sliding TTL. Browsers attach the cookie to HTTP and WebSocket upgrades
without exposing the bearer token to client JavaScript. If Redis is down, a
request gets a bounded ephemeral identity fallback rather than hanging.

900 possible name combinations (30 adjectives x 30 nouns). Collisions are harmless -- names are for display only, the UUID is what matters.

---

## How realtime works

1. Client opens the page -- SvelteKit renders HTML server-side
2. Client JS boots -- WebSocket connects via `svelte-adapter-uws`
3. Client subscribes to live streams (`notes`, `settings`, `activity`) -- gets initial data + events
4. User does something (creates a note, drags, edits) -- calls a `live()` RPC over WebSocket
5. Server validates input, writes to Postgres, publishes an event to the topic
6. All subscribed clients receive the event and update their local store
7. Svelte reactivity re-renders the changed parts of the UI

Cursors bypass the database. Positions go through Redis pub/sub and are rendered on a Canvas 2D overlay.

Board cleanup runs as a `live.cron()` job every minute. It queries for boards where `last_activity` is older than 1 hour, deletes them, and publishes `deleted` events so all home page viewers see the board disappear.

---

## License

MIT
