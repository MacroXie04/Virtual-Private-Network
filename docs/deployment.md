# Deployment

Start with the [prerequisites and secret-file requirements](../README.md#prerequisites). Run the commands below from the repository root. After deployment, complete the [operational verification](operations.md#verification).

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

The initial exit is retained as the default. To let users choose additional exits, also configure `TS_API_KEY_FILE` and prepare enrollment credentials as described in [exit management](operations.md#let-users-choose-an-exit). Each additional exit enrolls a separate gateway identity in the same Tailnet; allow each identity's gateway tag to use its exit without granting peer or subnet access.

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
sudo ./deploy/docker/compose-up.sh
docker compose ps
docker compose exec -T vpn-gateway node /app/src/runtime/healthcheck.js
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
  bash deploy/systemd/install.sh
```

The installer validates and atomically copies the Tunnel token to `/etc/vpn-gateway/secrets/cloudflare-tunnel-token`, creates the isolated `vpn-tunnel` identity, and supplies the token through systemd `LoadCredential`; the raw token is never placed in cloudflared's arguments. `vpn-gateway.target` owns the Tunnel lifecycle. Its local metrics/readiness endpoint is `127.0.0.1:20241`. Both launchers restrict cloudflared to fatal-only logs because request-error URLs can contain a subscription token or WebSocket path. The installer does not change Cloudflare, DNS, provider-firewall, or host-firewall configuration.

## Firewall and network boundary

Cloudflare must be the only public application ingress. Deny unsolicited inbound traffic at both the provider firewall/security group and the host firewall; if management access is unavoidable, restrict it to a separately approved source or private management plane. In particular, never allow inbound TCP `443`, `8443`, `8080`, `8081`, or `20241` to the server.

Allow the outbound DNS, HTTPS, Cloudflare Tunnel, and Tailscale control/DERP/STUN traffic required by current vendor documentation. Do not force VPN payload traffic through a host-level direct route: every published profile and its DNS traffic route through the corresponding Tailscale endpoint, with the original endpoint retained as the default.

“No public inbound exposure” means the server may retain a public IP while all unsolicited inbound paths are denied. “No public IP assigned” is different: the provider must supply outbound NAT so cloudflared, Tailscale control/DERP, DNS, package updates, and any required APIs remain reachable.
