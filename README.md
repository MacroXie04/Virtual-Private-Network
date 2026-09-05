# Multi-user VPN gateway

A multi-user VLESS WebSocket gateway with Cloudflare as its only public ingress and a selected Tailscale Exit Node as its only VPN egress.

```text
Shadowrocket -> VLESS over WSS -> Cloudflare :443 -> Named Tunnel
             -> cloudflared -> 127.0.0.1:8443 -> sing-box
             -> embedded tsnet -> selected Tailscale Exit Node -> Internet
```

Cloudflare terminates public TLS. The origin accepts plain WebSocket only on loopback; subscriptions (`127.0.0.1:8080`) and administration (`127.0.0.1:8081`) are loopback-only too. There is no direct or fallback VPN outbound. Loss of the Tunnel, Tailscale identity, selected Exit Node, exit-routed DNS, or routed health probe fails closed.

## Prerequisites

- A Cloudflare account, a domain using Cloudflare DNS, and one remotely managed Named Tunnel.
- Three distinct public DNS names, for example `vpn.example.com`, `sub.example.com`, and `admin.example.com`.
- An independent operator-controlled public hostname for the routed TCP 443 health probe. It must not be any Tunnel hostname.
- An approved Tailscale Exit Node, a one-time tagged Tailscale auth-key file, and a Tailnet policy that permits Internet/Exit-Node use but denies peers, services, and subnet routes.
- Docker Compose, or Debian/Ubuntu with systemd 247+, Node.js `>=24.20.0 <25`, sing-box exactly `1.13.21` with `with_tailscale` and `with_utls`, and cloudflared exactly `2026.8.3` installed at `/usr/bin/cloudflared`.

Keep every secret outside this repository in a real, root-owned, singly linked file with mode `0400` or `0600`. Never put a Tailscale key or Cloudflare token value in `.env`, a command argument, a unit override, application state, or logs. `.env` contains paths to secret files, not their contents.

## Configure the Named Tunnel

Create a [remotely managed Named Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) in the Cloudflare dashboard, then add its [published application routes](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/#2a-publish-an-application). On Docker the addresses are evaluated inside the network namespace shared by the gateway and cloudflared containers.

| Public hostname | Tunnel origin service |
| --- | --- |
| `vpn.example.com` | `http://127.0.0.1:8443` |
| `sub.example.com` | `http://127.0.0.1:8080` |
| `admin.example.com` | `http://127.0.0.1:8081` |

The three DNS records must point only to the Named Tunnel. Delete any `A` or `AAAA` record that reveals or targets the server. Preserve the original `Host` header.

For the VPN hostname:

- Enable [WebSockets](https://developers.cloudflare.com/network/websockets/) and disable caching.
- Do not use redirects, JavaScript/browser challenges, or interactive Cloudflare Access. They break VLESS WebSocket clients.
- Apply suitable non-interactive WAF and rate-limit rules, and redact the WebSocket path from edge, proxy, and analytics logs.

Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) in front of the admin hostname as an additional control; application administrator authentication, secure cookies, CSRF checks, exact Host/Origin checks, and rate limits remain required. Do not put interactive Access in front of subscriptions unless every client can supply supported non-interactive credentials. Redact subscription-token paths from all logs.

Cloudflare can see traffic at public TLS termination and is part of the trust boundary. Confirm that sustained proxy traffic through a public Tunnel is permitted by the current Cloudflare plan limits and [service-specific terms for Zero Trust Services](https://www.cloudflare.com/service-specific-terms-zero-trust-services/) before production use.

## Docker

Copy `.env.example` to `.env`, then set the five public settings, the initial Exit Node, and absolute secret-file paths. Leave `WS_PATH` empty on first bootstrap to generate a high-entropy canonical path.

```dotenv
TS_AUTH_KEY_FILE=/root/vpn-secrets/tailscale-auth-key
CLOUDFLARE_TUNNEL_TOKEN_FILE=/root/vpn-secrets/cloudflare-tunnel-token
EXIT_NODE=100.64.0.10
VPN_PUBLIC_HOSTNAME=vpn.example.com
SUBSCRIPTION_PUBLIC_BASE_URL=https://sub.example.com
ADMIN_PUBLIC_HOSTNAME=admin.example.com
EGRESS_HEALTH_HOST=health-origin.example.net
WS_PATH=
```

Start through the guarded wrapper, then check both containers:

```bash
sudo ./docker/compose-up.sh
docker compose ps
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
docker inspect "$(docker compose ps -q vpn-gateway)" --format '{{json .NetworkSettings.Ports}}'
```

The final inspection must show no published ports. Do not add `ports`, `expose`, or host networking. Back up the `vpn-data` volume before upgrades, and never run `docker compose down -v` unless permanent state deletion is intended.

## Bare metal

Install the pinned dependencies from trusted packages first; the installer never downloads executables. Create the Tunnel token source file with a trusted root-only editor, then verify without printing it:

```bash
sudo install -d -o root -g root -m 0700 /root/vpn-secrets
sudo install -o root -g root -m 0600 /dev/null /root/vpn-secrets/cloudflare-tunnel-token
sudo stat -c '%U:%G %a %h %s' /root/vpn-secrets/cloudflare-tunnel-token
/usr/bin/cloudflared --version
```

Place the dashboard-issued token in that file without passing it on a command line or through shell history. The final `stat` result must be `root:root`, mode `600`, one link, and nonzero size. Run the installer with public values and secret *paths* only:

```bash
sudo env \
  TS_AUTH_KEY_FILE=/root/vpn-secrets/tailscale-auth-key \
  CLOUDFLARE_TUNNEL_TOKEN_FILE=/root/vpn-secrets/cloudflare-tunnel-token \
  EXIT_NODE=100.64.0.10 \
  VPN_PUBLIC_HOSTNAME=vpn.example.com \
  SUBSCRIPTION_PUBLIC_BASE_URL=https://sub.example.com \
  ADMIN_PUBLIC_HOSTNAME=admin.example.com \
  EGRESS_HEALTH_HOST=health-origin.example.net \
  bash server/install.sh
```

The installer validates and atomically copies the Tunnel token to `/etc/vpn-gateway/secrets/cloudflare-tunnel-token`, creates the isolated `vpn-tunnel` identity, and supplies the token through systemd `LoadCredential`; the raw token is never placed in cloudflared's arguments. `vpn-gateway.target` owns the Tunnel lifecycle. Its local metrics/readiness endpoint is `127.0.0.1:20241`. Both launchers restrict cloudflared to fatal-only logs because request-error URLs can contain a subscription token or WebSocket path. The installer does not change Cloudflare, DNS, provider-firewall, or host-firewall configuration.

## Firewall and network boundary

Cloudflare must be the only public application ingress. Deny unsolicited inbound traffic at both the provider firewall/security group and the host firewall; if management access is unavoidable, restrict it to a separately approved source or private management plane. In particular, never allow inbound TCP `443`, `8443`, `8080`, `8081`, or `20241` to the server.

Allow the outbound DNS, HTTPS, Cloudflare Tunnel, and Tailscale control/DERP/STUN traffic required by current vendor documentation. Do not force VPN payload traffic through a host-level direct route: sing-box has exactly one final Tailscale outbound.

“No public inbound exposure” means the server may retain a public IP while all unsolicited inbound paths are denied. “No public IP assigned” is different: the provider must supply outbound NAT so cloudflared, Tailscale control/DERP, DNS, package updates, and any required APIs remain reachable.

## Administration and subscriptions

Browse only `https://ADMIN_PUBLIC_HOSTNAME` through Cloudflare; never browse or forward the plain loopback backend. Cloudflare Access is not a replacement for the application administrator secret.

If `/var/lib/vpn-gateway/admin-secret` exists after first initialization, retrieve it once, store it in a password manager, confirm login, and remove the handoff file. Each user has an independent VLESS UUID and subscription token. Supported endpoints remain:

- `/s/TOKEN`
- `/s/TOKEN/links`
- `/s/TOKEN/sing-box`
- `/s/TOKEN/clash`

## Upgrades, migration, and rollback

Back up `/var/lib/vpn-gateway`, `/etc/vpn-gateway`, `/opt/vpn-gateway`, and the `vpn-gateway*` unit files as one stopped, access-controlled set. Never restore only pointers or selected revision files.

The bare installer records service state, deployment files, the complete protected revision namespace, and atomic pointers before mutation. It holds boot enablement during the upgrade, automatically restores the previous deployment when readiness fails, and replays an interrupted rollback journal on the next run. The reported `/var/backups/vpn-gateway/upgrade-*` directory contains credentials: keep it root-only until the upgraded gateway is verified, then securely retire it after the rollback window.

Migration from the existing REALITY schema is one-way and requires `MIGRATE_REALITY=1` together with the Tunnel token path and all five Cloudflare/health settings shown above. It preserves users, UUIDs, token hashes, audit history, Exit Node selection, and Tailscale identity, but removes REALITY keys and creates a new WebSocket revision. Every old REALITY profile stops working; users must refresh or re-import subscriptions after commit. A legacy-v1 migration similarly requires those settings and `MIGRATE_LEGACY=1` after reviewing its dry run.

## Verification

On the origin, verify the target, routed egress health, Tunnel edge connection, and loopback-only listeners:

```bash
sudo systemctl --no-pager --full status vpn-gateway.target vpn-gateway-tunnel.service
sudo cloudflared tunnel --metrics 127.0.0.1:20241 ready
sudo node /opt/vpn-gateway/src/healthcheck.js
sudo ss -ltnp | grep -E ':(443|8443|8080|8081|20241)\b'
```

There must be no listener on origin port 443; the other four listeners must show only `127.0.0.1`. From a network outside the server, confirm that the origin public IP refuses the listed ports and that the three public DNS names resolve only through the Named Tunnel. Test the VPN WebSocket route without challenges, the admin Access policy plus application login, and a real subscription client.

Finally, compare the public IP observed from an authenticated VPN client with the selected Exit Node's egress IP. Stop cloudflared and separately make the Exit Node or routed DNS unavailable: Tunnel loss must remove public reachability, while egress loss must keep the gateway in maintenance and subscriptions at `503`; neither failure may create direct VPS egress.

Repository tests and static configuration checks do not prove the external DNS, Cloudflare dashboard policy, provider firewall, origin reachability, or observed Exit-Node IP. Those live checks are intentionally not performed by this repository and remain required before production acceptance.

## Development

```bash
npm test
```
