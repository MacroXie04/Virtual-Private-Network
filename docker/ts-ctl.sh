#!/bin/sh
# 容器版 ts-ctl.sh：无 systemd，直接操作文件并通过 pkill 触发 entrypoint 的重启循环。
# 用法：
#   ts-ctl.sh apply <tmpfile>   校验并安装新的 sing-box 配置，然后重启 sing-box
#   ts-ctl.sh logs              输出 sing-box 日志中 tailscale 相关的近期行
set -eu

CONFIG="${SINGBOX_CONFIG:-/data/config.json}"
LOG="${SINGBOX_LOG:-/data/sing-box.log}"

case "${1:-}" in
  apply)
    tmp="${2:-}"
    case "$tmp" in
      /tmp/*) ;;
      *) echo "非法的临时文件路径" >&2; exit 1 ;;
    esac
    [ -f "$tmp" ] || { echo "临时文件不存在" >&2; exit 1; }
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
    echo "用法: $0 {apply <tmpfile>|logs}" >&2
    exit 1
    ;;
esac
