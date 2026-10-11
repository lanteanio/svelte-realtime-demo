#!/bin/sh
set -eu
mode=${1:-}
case "$mode" in apply|remove) ;; *) echo 'usage: firewall-rules.sh apply|remove' >&2; exit 2;; esac
interface=eth0
case "$interface" in *[!a-zA-Z0-9_.:-]*|'') echo invalid-interface >&2; exit 2;; esac
temp=$(mktemp -d)
trap 'rm -f "$temp/v4" "$temp/v6" "$temp/current"; rmdir "$temp"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for family in 4 6; do
  if [ "$family" = 4 ]; then bin=iptables; restore=iptables-restore; else bin=ip6tables; restore=ip6tables-restore; fi
  file="$temp/v$family"
  "$bin" -w 5 -S > "$temp/current"
  # Do not adopt a same-named chain installed by another administrator.
  for chain in DEMO-INPUT DEMO-FORWARD; do
    if grep -q -- "^-N $chain$" "$temp/current" && ! grep -q -- "^-A $chain .*demo-access-v1" "$temp/current"; then
      echo "unrecognized-existing-chain=$chain family=$family" >&2; exit 1
    fi
  done
  {
    echo '*filter'
    if [ "$mode" = apply ]; then
      echo ':DEMO-INPUT - [0:0]'
      echo ':DEMO-FORWARD - [0:0]'
      if ! grep -q -- '^-N DOCKER-USER$' "$temp/current"; then
        echo ':DOCKER-USER - [0:0]'
      fi
      echo '-F DEMO-INPUT'
      echo '-F DEMO-FORWARD'
    fi
    # Remove only exact owned jumps; preserve every unrelated rule and policy.
    while IFS= read -r line; do
      case "$line" in
        '-A INPUT -j DEMO-INPUT'|'-A DOCKER-USER -j DEMO-FORWARD') printf '%s\n' "-D${line#-A}";;
      esac
    done < "$temp/current"
    if [ "$mode" = apply ]; then
      echo '-A DEMO-INPUT -i lo -m comment --comment demo-access-v1 -j ACCEPT'
      echo '-A DEMO-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
      echo '-A DEMO-INPUT -m conntrack --ctstate INVALID -j DROP'
      echo '-A DEMO-INPUT -p tcp -m multiport --dports 22,80,443 -j ACCEPT'
      if [ "$family" = 4 ]; then
        echo '-A DEMO-INPUT -p icmp -j ACCEPT'
        printf '%s\n' "-A DEMO-INPUT -i $interface -p udp --sport 67 --dport 68 -j ACCEPT"
      else
        echo '-A DEMO-INPUT -p ipv6-icmp -j ACCEPT'
      fi
      echo '-A DEMO-INPUT -j DROP'
      echo '-A DEMO-FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment demo-access-v1 -j RETURN'
      echo '-A DEMO-FORWARD -m conntrack --ctstate INVALID -j DROP'
      printf '%s\n' "-A DEMO-FORWARD ! -i $interface -j RETURN"
      for port in 22 80 443; do
        printf '%s\n' "-A DEMO-FORWARD -i $interface -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport $port -j RETURN"
      done
      echo '-A DEMO-FORWARD -j DROP'
      echo '-I INPUT 1 -j DEMO-INPUT'
      echo '-I DOCKER-USER 1 -j DEMO-FORWARD'
    else
      for chain in DEMO-INPUT DEMO-FORWARD; do
        if grep -q -- "^-N $chain$" "$temp/current"; then
          echo "-F $chain"
          echo "-X $chain"
        fi
      done
    fi
    echo COMMIT
  } > "$file"
  "$restore" --wait 5 --test --noflush < "$file"
done
# Both families validate before either changes. A scheduled outside rollback
# remains required because two address families are two kernel transactions.
iptables-restore --wait 5 --noflush < "$temp/v4"
ip6tables-restore --wait 5 --noflush < "$temp/v6"
