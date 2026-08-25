#!/bin/sh
# 容器入口：首次启动生成凭据并渲染 sing-box 配置，然后以"重启循环"方式运行 sing-box，
# 前台运行 Node 订阅/Web UI 服务。所有进程均为容器内 root，无需 sudo。
set -eu

DATA=/data

# 必填参数
for v in TS_AUTH_KEY EXIT_NODE VPS_HOST; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "缺少环境变量 $v" >&2
    exit 1
  fi
done
SERVER_NAME=${SERVER_NAME:-www.microsoft.com}
NODE_NAME=${NODE_NAME:-vps-reality}

mkdir -p "$DATA/tailscale"

# 首次启动：生成并持久化凭据（之后重启复用，客户端订阅不变）
if [ ! -f "$DATA/env" ]; then
  echo "首次启动：生成 UUID / REALITY 密钥对 / Short ID / SUB_TOKEN"
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

# 仅当配置不存在时渲染模板；之后以卷内配置为准（Web UI 对出口/auth key 的修改才不会被覆盖）
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

# sing-box 重启循环：ts-ctl.sh apply 通过 pkill 触发重启
(
  while :; do
    # 日志超 512KB 时截断保留末尾 1000 行（仅在重启间隙执行，tee 持有 fd 时不动它）
    if [ -f "$SINGBOX_LOG" ] && [ "$(wc -c < "$SINGBOX_LOG")" -gt 524288 ]; then
      tail -n 1000 "$SINGBOX_LOG" > "$SINGBOX_LOG.tmp" && mv "$SINGBOX_LOG.tmp" "$SINGBOX_LOG"
    fi
    sing-box run -c "$DATA/config.json" 2>&1 | tee -a "$SINGBOX_LOG"
    echo "sing-box 已退出，1 秒后重启…" | tee -a "$SINGBOX_LOG"
    sleep 1
  done
) &
LOOP_PID=$!

node /app/server.js &
NODE_PID=$!
trap 'kill "$NODE_PID" "$LOOP_PID" 2>/dev/null; pkill -x sing-box 2>/dev/null || true' TERM INT

echo "订阅地址: http://${VPS_HOST}:${LISTEN_PORT}/${SUB_TOKEN}"
wait "$NODE_PID"
