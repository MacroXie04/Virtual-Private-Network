# Multi-user VPN gateway

A hardened VLESS + REALITY gateway that sends VPN traffic through a selected Tailscale Exit Node.

```text
Shadowrocket / VLESS client -> TCP 443 -> sing-box -> Tailscale Exit Node -> Internet
```

Each user gets an independent VLESS UUID and subscription token. The gateway has no direct outbound fallback: if Tailscale or the Exit Node fails, subscriptions and VPN readiness fail closed.

## Features

- Multi-user create, disable, rotate, and revoke workflows
- VLESS + REALITY on TCP 443
- Embedded, persistent Tailscale identity
- Exit-routed DNS and health checks
- Web administration through a private HTTPS frontend
- Docker Compose and Debian/Ubuntu systemd deployment

## Requirements

- A VPS with TCP 443 available
- Docker with Compose, or Debian/Ubuntu with systemd
- An approved Tailscale Exit Node
- A one-time Tailscale auth key for a dedicated gateway tag
- A Tailnet policy that permits Internet egress but denies peers and subnet routes
- An HTTPS origin you are authorized to use as the REALITY target

## Quick start with Docker

Store the Tailscale auth key outside this repository in a root-owned file with mode `0600`, then configure the gateway:

```bash
cp .env.example .env
chmod 0600 .env
```

Set at least these values in `.env`:

```dotenv
TS_AUTH_KEY_FILE=/absolute/path/to/tailscale-auth-key
EXIT_NODE=100.64.0.10
VPS_HOST=vpn.example.com
SERVER_NAME=your-authorized-origin.example
```

Build, start, and verify:

```bash
docker compose up -d --build
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
```

Retrieve the one-time administrator secret and save it in a password manager:

```bash
docker compose exec -T vpn-gateway cat /data/admin-secret
```

After confirming the saved secret works, remove the plaintext recovery copy. Back up the `vpn-data` volume before upgrades, and never run `docker compose down -v` unless you intend to erase all gateway state.

## Administration

The admin backend listens only on `127.0.0.1:8081` and must not be exposed directly. Use a trusted TLS frontend and an SSH tunnel; [server/operator-admin.Caddyfile](server/operator-admin.Caddyfile) is included for this purpose.

The subscription service listens on `127.0.0.1:8080`. A user's token supports:

- `/s/TOKEN` — base64 subscription
- `/s/TOKEN/links` — plain VLESS link
- `/s/TOKEN/sing-box` — sing-box JSON
- `/s/TOKEN/clash` — Clash Meta YAML

Only TCP 443 should be publicly reachable. Keep ports 8080 and 8081 private.

## Bare-metal install

On a supported Debian or Ubuntu system with Node.js 24 and sing-box 1.13.21:

```bash
sudo bash server/install.sh
```

The installer prompts for required settings and installs the isolated systemd services.

## Development

```bash
npm test
```

The test suite covers state transactions, migrations, lifecycle operations, HTTP boundaries, controller behavior, and deployment layout.
