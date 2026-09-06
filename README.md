# Multi-user VPN gateway

[![CI](https://github.com/MacroXie04/Virtual-Private-Network/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MacroXie04/Virtual-Private-Network/actions/workflows/ci.yml)

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

## Guides

- [Deployment](docs/deployment.md): configure the Named Tunnel, deploy with Docker or systemd, and establish the firewall boundary.
- [Operations](docs/operations.md): administer users and subscriptions, upgrade or migrate, recover deployments, and verify production behavior.
- [Development](docs/development.md): understand the repository layout, choose where new files belong, and run tests and CI checks.
