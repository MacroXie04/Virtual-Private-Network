#!/usr/bin/env bash
# 一键部署：sing-box (VLESS+REALITY) + Tailscale Exit Node 出口 + 订阅服务
# 适用于 Debian / Ubuntu，需 root 运行：sudo bash server/install.sh
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "请用 root 运行：sudo bash server/install.sh" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 安装 sing-box"
if ! command -v sing-box >/dev/null 2>&1; then
  curl -fsSL https://sing-box.app/install.sh | sh
fi
sing-box version

echo "==> 检查 Node.js（订阅服务需要 >= 18）"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 18 ]]; then
  apt-get update && apt-get install -y nodejs
fi
node -v

echo
echo "==> 填写部署参数"
read -rsp "Tailscale auth key (tskey-auth-...，后台 Settings → Keys 生成): " TS_AUTH_KEY; echo
read -rp  "Exit Node 地址（100.x.x.x 或 tailnet 机器名）: " EXIT_NODE
read -rp  "本机公网地址（IP 或域名，写入订阅链接）: " VPS_HOST
read -rp  "REALITY 伪装域名 [www.microsoft.com]: " SERVER_NAME
SERVER_NAME=${SERVER_NAME:-www.microsoft.com}
read -rp  "Tailscale API access token（可选，用于 Web UI 下拉列出 Exit Node；留空则手输）: " TS_API_KEY
[[ -n "$TS_AUTH_KEY" && -n "$EXIT_NODE" && -n "$VPS_HOST" ]] || { echo "参数不能为空" >&2; exit 1; }

echo
echo "==> 生成密钥与凭据"
UUID=$(sing-box generate uuid)
SHORT_ID=$(openssl rand -hex 8)
KEYPAIR=$(sing-box generate reality-keypair)
REALITY_PRIVATE_KEY=$(awk '/PrivateKey/{print $2}' <<<"$KEYPAIR")
REALITY_PUBLIC_KEY=$(awk '/PublicKey/{print $2}' <<<"$KEYPAIR")
SUB_TOKEN=$(openssl rand -hex 16)

echo "==> 创建 vpn-sub 系统用户"
id -u vpn-sub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vpn-sub

echo "==> 渲染 sing-box 配置"
install -d -m 700 /var/lib/sing-box/tailscale
sed -e "s|\${UUID}|${UUID}|g" \
    -e "s|\${SERVER_NAME}|${SERVER_NAME}|g" \
    -e "s|\${REALITY_PRIVATE_KEY}|${REALITY_PRIVATE_KEY}|g" \
    -e "s|\${SHORT_ID}|${SHORT_ID}|g" \
    -e "s|\${TS_AUTH_KEY}|${TS_AUTH_KEY}|g" \
    -e "s|\${EXIT_NODE}|${EXIT_NODE}|g" \
    "$REPO_DIR/server/config.template.json" > /etc/sing-box/config.json
chown root:vpn-sub /etc/sing-box/config.json
chmod 640 /etc/sing-box/config.json
sing-box check -c /etc/sing-box/config.json

echo "==> 安装订阅服务"
install -d /opt/vpn-sub
install -m 644 "$REPO_DIR/sub/generate.js" "$REPO_DIR/sub/server.js" "$REPO_DIR/sub/tailscale.js" "$REPO_DIR/sub/page.js" /opt/vpn-sub/
install -m 755 "$REPO_DIR/server/ts-ctl.sh" /opt/vpn-sub/ts-ctl.sh

echo "==> 配置 sudoers（仅放行 ts-ctl.sh）"
cat > /etc/sudoers.d/vpn-sub <<'EOF'
vpn-sub ALL=(root) NOPASSWD: /opt/vpn-sub/ts-ctl.sh *
EOF
chmod 440 /etc/sudoers.d/vpn-sub
visudo -cf /etc/sudoers.d/vpn-sub
cat > /etc/vpn-sub.env <<EOF
LISTEN_PORT=8080
SUB_TOKEN=${SUB_TOKEN}
VPS_HOST=${VPS_HOST}
NODE_PORT=443
NODE_NAME=vps-reality
UUID=${UUID}
SERVER_NAME=${SERVER_NAME}
REALITY_PUBLIC_KEY=${REALITY_PUBLIC_KEY}
SHORT_ID=${SHORT_ID}
EOF
if [[ -n "$TS_API_KEY" ]]; then
  echo "TS_API_KEY=${TS_API_KEY}" >> /etc/vpn-sub.env
fi
chmod 600 /etc/vpn-sub.env
sed "s|__NODE__|$(command -v node)|" "$REPO_DIR/server/sub-server.service" > /etc/systemd/system/vpn-sub.service
systemctl daemon-reload

echo "==> 启动服务"
systemctl enable --now sing-box
systemctl restart sing-box
systemctl enable --now vpn-sub
systemctl restart vpn-sub

cat <<EOF

============================================================
部署完成。客户端参数：
  UUID:              ${UUID}
  REALITY PublicKey: ${REALITY_PUBLIC_KEY}
  Short ID:          ${SHORT_ID}
  SNI:               ${SERVER_NAME}

订阅地址：
  通用(mixed):  http://${VPS_HOST}:8080/${SUB_TOKEN}
  sing-box:     http://${VPS_HOST}:8080/${SUB_TOKEN}/singbox
  Clash Meta:   http://${VPS_HOST}:8080/${SUB_TOKEN}/clash

注意：
  - 防火墙/安全组需放行 443/tcp；远程拉订阅还需放行 8080/tcp
  - 订阅走明文 HTTP + 随机路径，泄露 token 等于泄露节点，请勿公开传播
  - 首次启动后在 Tailscale 后台确认 proxy-vps 已上线并使用了 Exit Node
  - 验证出口：连上节点后访问 ip.sb，应显示 Exit Node 的出口 IP
============================================================
EOF
