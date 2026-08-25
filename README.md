# Virtual Private Network

VPS proxy backend: sing-box provides a **VLESS + REALITY** inbound, and outbound traffic exits through a designated **Exit Node** via **embedded Tailscale (tsnet)**. Includes a zero-dependency, minimal subscription service. No domain or certificate required.

```
Client → VLESS+REALITY → VPS (sing-box) → Tailscale tunnel → Exit Node → Internet
                              └─ Subscription service (Node, port 8080)
```

Tailscale runs in userspace inside the sing-box process — **no changes to the VPS system routes**, so SSH and inbound proxy connections are unaffected.

## Prerequisites

- A VPS with a public IP (Debian/Ubuntu)
- A configured Tailscale Exit Node (`--advertise-exit-node`, approved in the admin console)
- A Tailscale account; generate an auth key under Settings → Keys (reusable recommended, key expiry disabled)

## Deployment

### Option 1: Docker (recommended)

```bash
cp .env.example .env   # fill in TS_AUTH_KEY / EXIT_NODE / VPS_HOST
docker compose up -d --build
docker compose logs    # the first start prints the subscription URL
```

- On first start, the UUID, REALITY keypair, Short ID, and SUB_TOKEN are generated automatically and persisted in the `vpn-data` volume (`/data/env`), so they survive restarts
- tsnet state, the rendered sing-box config, and logs also live in that volume
- Tailscale control in the Web UI is fully functional inside the container (sing-box restarts automatically after a config change); note that the config is rendered from environment variables only on the **first** start — afterwards the in-volume `/data/config.json` is authoritative. Changing `EXIT_NODE` and other environment variables will not overwrite the existing config; to reset, delete `config.json` from the volume and restart
- No privileged mode or TUN device mapping needed (tsnet is a userspace network stack)

### Option 2: Bare-metal with systemd

```bash
git clone <this repo> && cd Virtual-Private-Network
sudo bash server/install.sh
```

The script will, in order:

1. Install sing-box and Node.js (if missing)
2. Prompt for the Tailscale auth key, Exit Node address, this host's public address, REALITY camouflage domain, and an optional Tailscale API token
3. Generate the UUID, REALITY keypair, Short ID, and subscription token
4. Render `/etc/sing-box/config.json` (template: `server/config.template.json`) and validate it with `sing-box check`
5. Create the `vpn-sub` system user and a sudoers rule (allowing only `/opt/vpn-sub/ts-ctl.sh`)
6. Install and start `sing-box.service` and `vpn-sub.service` (the subscription service)

When finished it prints the client parameters and subscription URL. The firewall must allow `443/tcp`; fetching subscriptions remotely also requires `8080/tcp`.

## Subscription & clients

Opening `http://<VPS>:8080/<SUB_TOKEN>` in a browser shows a web UI: node info, share link (with QR code), one-click copy for each subscription format, config file downloads, and **Tailscale exit control** (see next section).

| Format | URL |
| --- | --- |
| Generic (mixed) (base64 links) | `http://<VPS>:8080/<SUB_TOKEN>` |
| Full sing-box config | `http://<VPS>:8080/<SUB_TOKEN>/singbox` |
| Clash Meta (mihomo) | `http://<VPS>:8080/<SUB_TOKEN>/clash` |
| Plain-text share links | `http://<VPS>:8080/<SUB_TOKEN>/links` |

Without a suffix, the format is sniffed from request headers: browsers (Accept contains text/html) get the web UI, sing-box / Clash clients automatically get their format, everything else gets mixed. v2rayN, Nekoray, Clash Verge (Meta core), and the official sing-box clients all support VLESS+REALITY.

If you don't want to expose the HTTP subscription port, generate locally on the VPS and import manually:

```bash
set -a && . /etc/vpn-sub.env && set +a
node /opt/vpn-sub/generate.js          # share links
node /opt/vpn-sub/generate.js singbox  # or mixed / clash
```

**Note**: subscriptions use plain HTTP with a random path — a leaked token means a leaked node (and it can also change the exit config and trigger a sing-box restart). If you have a domain, putting Caddy HTTPS in front is recommended.

## Controlling Tailscale from the Web UI

The "Tailscale Exit" card in the web UI can:

- Show the sing-box service status, current Exit Node, auth key (masked), tsnet hostname, and recent tailscale-related logs
- Change the Tailscale auth key (leave blank to keep unchanged; tsnet only supports auth key login)
- Switch the Exit Node: if a Tailscale API access token was provided at deploy time (generate under Settings → Keys; note it expires after ~90 days), the input gets a dropdown listing every device in the tailnet that advertises exit node capability; without a token (or after it expires) it falls back to plain manual input, with no loss of functionality

Save flow: write to a temp file → the root helper script `/opt/vpn-sub/ts-ctl.sh` validates with `sing-box check` → replaces `/etc/sing-box/config.json` → `systemctl restart sing-box`. **Saving restarts sing-box; the proxy is interrupted for a few seconds.**

Permission model: the `vpn-sub` service runs as a dedicated system user without direct root access; a single sudoers rule allows only `/opt/vpn-sub/ts-ctl.sh` (config validation/install/restart, log reading). `/etc/sing-box/config.json` is owned `root:vpn-sub` with mode `0640`.

## Verification

1. `systemctl status sing-box vpn-sub` shows both as active
2. `proxy-vps` appears in the Tailscale admin console and is online (it registers via the auth key on first start)
3. After importing the subscription and connecting, visit `ip.sb` — it should show the **Exit Node's egress IP**

## Local development

```bash
npm test          # node --test, covers subscription generation logic
npm run links     # print share links from current environment variables
```

## Differences from the old (Cloudflare Worker) approach

- Tunnel forwarding is handled by sing-box on the VPS — no more dependency on Cloudflare Worker, no risk of platform bans
- The egress IP depends on your Exit Node, not a ProxyIP pool
- The inbound keeps only VLESS+REALITY (TCP); Trojan/Shadowsocks, WS/gRPC/XHTTP transports, the admin panel, and KV storage were removed
- Subscription generation is done by a local service on the VPS — no external subscription conversion API

## Directory layout

```
docker/
  Dockerfile               All-in-one image (sing-box + Node subscription service)
  entrypoint.sh            Container entrypoint: generate credentials, render config, sing-box restart loop
  ts-ctl.sh                Container control script (pkill triggers restart, reads log file)
docker-compose.yml         Orchestration (ports + vpn-data volume)
.env.example               Docker deployment parameter template
server/
  config.template.json     sing-box server config template (rendered by install.sh / entrypoint.sh)
  install.sh               One-shot bare-metal systemd deployment script
  sub-server.service       Subscription service systemd unit template
  ts-ctl.sh                Root helper: validate/install/restart sing-box config, read logs (allowed via sudoers)
sub/
  generate.js              Subscription/link generation (pure functions + CLI)
  server.js                Minimal subscription HTTP server (with Tailscale control POST endpoint)
  page.js                  Web UI (node info + Tailscale exit control card)
  tailscale.js             Tailscale config read/write and Exit Node list via API (pure functions)
test/unit/                 Subscription generation and Tailscale control tests
```
