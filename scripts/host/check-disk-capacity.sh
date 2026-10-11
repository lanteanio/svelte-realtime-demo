#!/bin/bash
set -euo pipefail
if [ "$#" -gt 1 ]; then echo 'usage: check-disk-capacity.sh [filesystem-path]' >&2; exit 64; fi
record=$(LC_ALL=C df -B1 --output=pcent,avail -- "${1:-/}")
test "$(printf '%s\n' "$record" | wc -l)" -eq 2
read -r used available extra <<< "$(printf '%s\n' "$record" | tail -n +2)"
[[ "$used" =~ ^[0-9]+%$ && "$available" =~ ^[0-9]+$ && -z "${extra:-}" ]]
used=${used%\%}
[[ ${#used} -le 3 && ${#available} -le 18 ]]
used=$((10#$used))
available=$((10#$available))
status=normal
code=0
if (( used >= 90 || available < 5 * 1024 * 1024 * 1024 )); then
  status=urgent; code=2
elif (( used >= 75 || available < 20 * 1024 * 1024 * 1024 )); then
  status=planning; code=1
fi
printf 'used_percent=%s available_bytes=%s status=%s\n' "$used" "$available" "$status"
exit "$code"
