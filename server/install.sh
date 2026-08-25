#!/usr/bin/env bash
# One-shot deployment: sing-box (VLESS+REALITY) + Tailscale Exit Node egress + subscription service
# For Debian / Ubuntu; must be run as root: sudo bash server/install.sh
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Please run as root: sudo bash server/install.sh" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Installing sing-box"
if ! command -v sing-box >/dev/null 2>&1; then
  curl -fsSL https://sing-box.app/install.sh | sh
fi
sing-box version

echo "==> Checking Node.js (subscription service requires >= 18)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 18 ]]; then
  apt-get update && apt-get install -y nodejs
fi
node -v

echo
echo "==> Enter deployment parameters"
read -rsp "Tailscale auth key (tskey-auth-..., generate under Settings → Keys): " TS_AUTH_KEY; echo
read -rp  "Exit Node address (100.x.x.x or tailnet machine name): " EXIT_NODE
read -rp  "This host's public address (IP or domain, embedded in subscription links): " VPS_HOST
read -rp  "REALITY camouflage domain [www.microsoft.com]: " SERVER_NAME
SERVER_NAME=${SERVER_NAME:-www.microsoft.com}
read -rp  "Tailscale API access token (optional, used by the Web UI to list Exit Nodes in a dropdown; leave blank for manual input): " TS_API_KEY
[[ -n "$TS_AUTH_KEY" && -n "$EXIT_NODE" && -n "$VPS_HOST" ]] || { echo "Parameters must not be empty" >&2; exit 1; }

echo
echo "==> Generating keys and credentials"
UUID=$(sing-box generate uuid)
SHORT_ID=$(openssl rand -hex 8)
KEYPAIR=$(sing-box generate reality-keypair)
REALITY_PRIVATE_KEY=$(awk '/PrivateKey/{print $2}' <<<"$KEYPAIR")
REALITY_PUBLIC_KEY=$(awk '/PublicKey/{print $2}' <<<"$KEYPAIR")
SUB_TOKEN=$(openssl rand -hex 16)

echo "==> Creating vpn-sub system user"
id -u vpn-sub >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vpn-sub

echo "==> Rendering sing-box config"
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

echo "==> Installing subscription service"
install -d /opt/vpn-sub
install -m 644 "$REPO_DIR/sub/generate.js" "$REPO_DIR/sub/server.js" "$REPO_DIR/sub/tailscale.js" "$REPO_DIR/sub/page.js" /opt/vpn-sub/
install -m 755 "$REPO_DIR/server/ts-ctl.sh" /opt/vpn-sub/ts-ctl.sh

echo "==> Configuring sudoers (allowing only ts-ctl.sh)"
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

echo "==> Starting services"
systemctl enable --now sing-box
systemctl restart sing-box
systemctl enable --now vpn-sub
systemctl restart vpn-sub

cat <<EOF

============================================================
Deployment complete. Client parameters:
  UUID:              ${UUID}
  REALITY PublicKey: ${REALITY_PUBLIC_KEY}
  Short ID:          ${SHORT_ID}
  SNI:               ${SERVER_NAME}

Subscription URLs:
  Generic (mixed): http://${VPS_HOST}:8080/${SUB_TOKEN}
  sing-box:        http://${VPS_HOST}:8080/${SUB_TOKEN}/singbox
  Clash Meta:      http://${VPS_HOST}:8080/${SUB_TOKEN}/clash

Notes:
  - Firewall/security group must allow 443/tcp; fetching subscriptions remotely also requires 8080/tcp
  - Subscriptions use plain HTTP with a random path — a leaked token means a leaked node; do not share it publicly
  - After the first start, confirm in the Tailscale admin console that proxy-vps is online and using the Exit Node
  - Verify egress: after connecting, visit ip.sb — it should show the Exit Node's egress IP
============================================================
EOF
