#!/bin/sh
# Container entrypoint: on first start, generate credentials and render the sing-box
# config, then run sing-box in a "restart loop" and run the Node subscription/Web UI
# service in the foreground. All processes run as root inside the container; no sudo needed.
set -eu

DATA=/data

# Required parameters
for v in TS_AUTH_KEY EXIT_NODE VPS_HOST; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "Missing environment variable $v" >&2
    exit 1
  fi
done
SERVER_NAME=${SERVER_NAME:-www.microsoft.com}
NODE_NAME=${NODE_NAME:-vps-reality}

mkdir -p "$DATA/tailscale"

# First start: generate and persist credentials (reused across restarts so client subscriptions don't change)
if [ ! -f "$DATA/env" ]; then
  echo "First start: generating UUID / REALITY keypair / Short ID / SUB_TOKEN"
  UUID=$(sing-box generate uuid)
  SHORT_ID=$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')
  SUB_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
  KEYPAIR=$(sing-box generate reality-keypair)
  REALITY_PRIVATE_KEY=$(printf '%s\n' "$KEYPAIR" | awk '/PrivateKey/{print $2}')
  REALITY_PUBLIC_KEY=$(printf '%s\n' "$KEYPAIR" | awk '/PublicKey/{print $2}')
  {
    echo "UUID=$UUID"
    echo "SHORT_ID=$SHORT_ID"
    echo "SUB_TOKEN=$SUB_TOKEN"
    echo "REALITY_PRIVATE_KEY=$REALITY_PRIVATE_KEY"
    echo "REALITY_PUBLIC_KEY=$REALITY_PUBLIC_KEY"
  } > "$DATA/env"
  chmod 600 "$DATA/env"
fi
set -a; . "$DATA/env"; set +a
export VPS_HOST SERVER_NAME NODE_NAME

# Render the template only when no config exists; afterwards the in-volume config is
# authoritative (so Web UI changes to the exit node / auth key are not overwritten)
if [ ! -f "$DATA/config.json" ]; then
  sed -e "s|\${UUID}|${UUID}|g" \
      -e "s|\${SERVER_NAME}|${SERVER_NAME}|g" \
      -e "s|\${REALITY_PRIVATE_KEY}|${REALITY_PRIVATE_KEY}|g" \
      -e "s|\${SHORT_ID}|${SHORT_ID}|g" \
      -e "s|\${TS_AUTH_KEY}|${TS_AUTH_KEY}|g" \
      -e "s|\${EXIT_NODE}|${EXIT_NODE}|g" \
      -e "s|/var/lib/sing-box/tailscale|${DATA}/tailscale|" \
      /app/config.template.json > "$DATA/config.json"
  chmod 600 "$DATA/config.json"
fi
sing-box check -c "$DATA/config.json"

# sing-box restart loop: ts-ctl.sh apply triggers a restart via pkill
(
  while :; do
    # Truncate the log to its last 1000 lines when it exceeds 512KB
    # (only done between restarts, while tee doesn't hold the fd)
    if [ -f "$SINGBOX_LOG" ] && [ "$(wc -c < "$SINGBOX_LOG")" -gt 524288 ]; then
      tail -n 1000 "$SINGBOX_LOG" > "$SINGBOX_LOG.tmp" && mv "$SINGBOX_LOG.tmp" "$SINGBOX_LOG"
    fi
    sing-box run -c "$DATA/config.json" 2>&1 | tee -a "$SINGBOX_LOG"
    echo "sing-box exited, restarting in 1 second..." | tee -a "$SINGBOX_LOG"
    sleep 1
  done
) &
LOOP_PID=$!

node /app/server.js &
NODE_PID=$!
trap 'kill "$NODE_PID" "$LOOP_PID" 2>/dev/null; pkill -x sing-box 2>/dev/null || true' TERM INT

echo "Subscription URL: http://${VPS_HOST}:${LISTEN_PORT}/${SUB_TOKEN}"
wait "$NODE_PID"
