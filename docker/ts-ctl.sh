#!/bin/sh
# Container version of ts-ctl.sh: no systemd; operates on files directly and triggers
# the entrypoint's restart loop via pkill.
# Usage:
#   ts-ctl.sh apply <tmpfile>   validate and install a new sing-box config, then restart sing-box
#   ts-ctl.sh logs              print recent tailscale-related lines from the sing-box log
set -eu

CONFIG="${SINGBOX_CONFIG:-/data/config.json}"
LOG="${SINGBOX_LOG:-/data/sing-box.log}"

case "${1:-}" in
  apply)
    tmp="${2:-}"
    case "$tmp" in
      /tmp/*) ;;
      *) echo "Invalid temporary file path" >&2; exit 1 ;;
    esac
    [ -f "$tmp" ] || { echo "Temporary file does not exist" >&2; exit 1; }
    sing-box check -c "$tmp"
    cp "$tmp" "$CONFIG"
    chmod 600 "$CONFIG"
    rm -f "$tmp"
    pkill -x sing-box || true
    ;;
  logs)
    grep -iE 'tailscale|tsnet|login|exit' "$LOG" 2>/dev/null | tail -n 30 || true
    ;;
  *)
    echo "Usage: $0 {apply <tmpfile>|logs}" >&2
    exit 1
    ;;
esac
