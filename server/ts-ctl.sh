#!/usr/bin/env bash
# Root privilege helper for vpn-sub, allowed individually via sudoers:
#   vpn-sub ALL=(root) NOPASSWD: /opt/vpn-sub/ts-ctl.sh *
# Usage:
#   ts-ctl.sh apply <tmpfile>   validate and install a new sing-box config, then restart sing-box
#   ts-ctl.sh logs              print recent tailscale-related lines from the sing-box log
set -euo pipefail

CONFIG="${SINGBOX_CONFIG:-/etc/sing-box/config.json}"

case "${1:-}" in
  apply)
    tmp="${2:-}"
    [[ "$tmp" == /tmp/* && -f "$tmp" && ! -L "$tmp" ]] || { echo "Invalid temporary file path" >&2; exit 1; }
    sing-box check -c "$tmp"
    install -m 640 -o root -g vpn-sub "$tmp" "$CONFIG"
    rm -f "$tmp"
    systemctl restart sing-box
    ;;
  logs)
    journalctl -u sing-box -n 200 --no-pager -o cat 2>/dev/null \
      | grep -iE 'tailscale|tsnet|login|exit' \
      | tail -n 30 || true
    ;;
  *)
    echo "Usage: $0 {apply <tmpfile>|logs}" >&2
    exit 1
    ;;
esac
