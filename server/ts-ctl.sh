#!/usr/bin/env bash
# vpn-sub 的 root 提权 helper，由 sudoers 单独放行：
#   vpn-sub ALL=(root) NOPASSWD: /opt/vpn-sub/ts-ctl.sh *
# 用法：
#   ts-ctl.sh apply <tmpfile>   校验并安装新的 sing-box 配置，然后重启 sing-box
#   ts-ctl.sh logs              输出 sing-box 日志中 tailscale 相关的近期行
set -euo pipefail

CONFIG="${SINGBOX_CONFIG:-/etc/sing-box/config.json}"

case "${1:-}" in
  apply)
    tmp="${2:-}"
    [[ "$tmp" == /tmp/* && -f "$tmp" && ! -L "$tmp" ]] || { echo "非法的临时文件路径" >&2; exit 1; }
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
    echo "用法: $0 {apply <tmpfile>|logs}" >&2
    exit 1
    ;;
esac
