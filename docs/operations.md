# Operations

See [deployment](deployment.md) for initial setup, Named Tunnel configuration, and the firewall boundary.

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

Migration from the existing REALITY schema is one-way and requires `MIGRATE_REALITY=1` together with the Tunnel token path and all five Cloudflare/health settings in the [deployment example](deployment.md#docker). It preserves users, UUIDs, token hashes, audit history, Exit Node selection, and Tailscale identity, but removes REALITY keys and creates a new WebSocket revision. Every old REALITY profile stops working; users must refresh or re-import subscriptions after commit. A legacy-v1 migration similarly requires those settings and `MIGRATE_LEGACY=1` after reviewing its dry run.

## Verification

On the origin, verify the target, routed egress health, Tunnel edge connection, and loopback-only listeners:

```bash
sudo systemctl --no-pager --full status vpn-gateway.target vpn-gateway-tunnel.service
sudo cloudflared tunnel --metrics 127.0.0.1:20241 ready
sudo node /opt/vpn-gateway/src/runtime/healthcheck.js
sudo ss -ltnp | grep -E ':(443|8443|8080|8081|20241)\b'
```

There must be no listener on origin port 443; the other four listeners must show only `127.0.0.1`. From a network outside the server, confirm that the origin public IP refuses the listed ports and that the three public DNS names resolve only through the Named Tunnel. Test the VPN WebSocket route without challenges, the admin Access policy plus application login, and a real subscription client.

Finally, compare the public IP observed from an authenticated VPN client with the selected Exit Node's egress IP. Stop cloudflared and separately make the Exit Node or routed DNS unavailable: Tunnel loss must remove public reachability, while egress loss must keep the gateway in maintenance and subscriptions at `503`; neither failure may create direct VPS egress.

Repository tests and static configuration checks do not prove the external DNS, Cloudflare dashboard policy, provider firewall, origin reachability, or observed Exit-Node IP. Those live checks are intentionally not performed by this repository and remain required before production acceptance.
