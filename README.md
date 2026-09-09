# Multi-user VPN gateway

[![CI](https://github.com/MacroXie04/Virtual-Private-Network/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MacroXie04/Virtual-Private-Network/actions/workflows/ci.yml)

A multi-user VLESS WebSocket gateway with Cloudflare as its only public ingress. Users choose a Tailscale Exit Node from the administrator-published list in their VPN client.

```text
Shadowrocket -> VLESS over WSS -> Cloudflare :443 -> Named Tunnel
             -> cloudflared -> 127.0.0.1:8443 -> sing-box
             -> embedded tsnet -> client-selected Tailscale Exit Node -> Internet
```

Cloudflare terminates public TLS. The origin accepts plain WebSocket only on loopback; subscriptions (`127.0.0.1:8080`) and administration (`127.0.0.1:8081`) are loopback-only too. There is no direct or fallback VPN outbound. Readiness checks cover every published exit and its routed DNS. A failed exit keeps public subscriptions in maintenance until repaired or removed; traffic never falls back to the gateway's public IP.

The original default exit remains available, with up to 15 additional published exits. Refreshing a subscription supplies the choices to VLESS subscription clients, a sing-box selector, or a Clash `select` group. Different users can select different exits at the same time, and switching in a client does not restart the gateway. All users receive the same published list; there are no per-user exit restrictions, automatic failover, or load balancing. See [exit management](docs/operations.md#let-users-choose-an-exit).

## Prerequisites

- A Cloudflare account, a domain using Cloudflare DNS, and one remotely managed Named Tunnel.
- Three distinct public DNS names, for example `vpn.example.com`, `sub.example.com`, and `admin.example.com`.
- An independent operator-controlled public hostname for the routed TCP 443 health probe. It must not be any Tunnel hostname.
- An approved Tailscale Exit Node, a one-time tagged Tailscale auth-key file, and a Tailnet policy that permits Internet/Exit-Node use but denies peers, services, and subnet routes.
- Docker Compose, or Debian/Ubuntu with systemd 247+, Node.js `>=24.20.0 <25`, sing-box exactly `1.13.21` with `with_tailscale` and `with_utls`, and cloudflared exactly `2026.8.3` installed at `/usr/bin/cloudflared`.

Keep every secret outside this repository in a real, root-owned, singly linked file with mode `0400` or `0600`. Never put a Tailscale key or Cloudflare token value in `.env`, a command argument, a unit override, manually edited application state, or logs. `.env` contains paths to secret files, not their contents. The controller uses enrollment keys in protected candidate revisions only until enrollment and routed health checks succeed, then removes them from revisions.

## Guides

- [Deployment](docs/deployment.md): configure the Named Tunnel, deploy with Docker or systemd, and establish the firewall boundary.
- [Operations](docs/operations.md): administer users and subscriptions, upgrade and recover current deployments, and verify production behavior.
- [Development](docs/development.md): understand the repository layout, choose where new files belong, and run tests and CI checks.
