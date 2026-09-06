#!/bin/sh
set -eu

readonly BINARY="${SINGBOX_BIN:-/usr/local/bin/sing-box}"
readonly CONFIG="${SINGBOX_CONFIG:-/var/lib/vpn-gateway/runtime/sing-box.json}"

case "$BINARY" in
  /*) ;;
  *)
    echo "SINGBOX_BIN must be an absolute path." >&2
    exit 1
    ;;
esac

case "$CONFIG" in
  /var/lib/vpn-gateway/runtime/*) ;;
  *)
    echo "SINGBOX_CONFIG must be inside /var/lib/vpn-gateway/runtime." >&2
    exit 1
    ;;
esac

if [ ! -x "$BINARY" ]; then
  echo "sing-box is not executable." >&2
  exit 1
fi
if [ ! -r "$CONFIG" ]; then
  echo "The active sing-box runtime configuration is not readable." >&2
  exit 1
fi

"$BINARY" check -c "$CONFIG"
exec "$BINARY" run -c "$CONFIG"
