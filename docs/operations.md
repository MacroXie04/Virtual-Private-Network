# Operations

See [deployment](deployment.md) for initial setup, Named Tunnel configuration, and the firewall boundary.

## Administration and subscriptions

Browse only `https://ADMIN_PUBLIC_HOSTNAME` through Cloudflare; never browse or forward the plain loopback backend. Cloudflare Access is not a replacement for the application administrator secret.

If `/var/lib/vpn-gateway/admin-secret` exists after first initialization, retrieve it once, store it in a password manager, confirm login, and remove the handoff file. Each user has an independent VLESS UUID and subscription token. Supported endpoints remain:

- `/s/TOKEN`
- `/s/TOKEN/links`
- `/s/TOKEN/sing-box`
- `/s/TOKEN/clash`

Import a subscription URL to receive all published exits. Plain and Base64 subscriptions contain one VLESS profile per exit; sing-box subscriptions include a selector and Clash subscriptions include a `select` group. The administrator's single-link export continues to use the default exit. A user's subscription token stays the same when exits change, while each exit profile has its own connection UUID.

## Let users choose an exit

The **Default exit node** control changes the exit used by existing single links and the default subscription entry. Under **Client-selectable exits**, an administrator can publish up to 15 additional approved Tailscale Exit Nodes or remove a published exit. Every active user can choose any published exit in their client. Users can choose different exits simultaneously, without an administration account or a gateway restart when they switch. This does not provide per-user exit access rules, automatic failover, or load balancing.

Before adding an exit:

1. Configure `TS_API_KEY_FILE` with a private Tailscale API/OAuth credential that can read the device directory. The picker accepts only currently authorized devices advertising an approved default route; an addition revalidates the device with the API.
2. Set the configured `TS_AUTH_KEY_FILE` to a fresh, unused tagged enrollment key, or a short-lived reusable tagged key while publishing several exits. The controller rereads this private file when adding an exit. The previously consumed one-time bootstrap key cannot enroll another identity. Keep the same restricted gateway tag and Tailnet policy as the original identity.
3. Choose a device under **Client-selectable exits** and select **Add to subscriptions**. Each published exit creates an additional gateway identity in Tailscale, with separate persistent state under the existing Tailscale state directory's `exits/ID` child. Ensure the policy permits that identity to use the selected exit and public Internet while denying Tailnet peers and subnet routes.
4. After enrollment and all routed probes succeed, users refresh their existing subscription and choose the desired exit in their VPN client. Enrollment keys are removed from current configuration and superseded revisions before readiness is published. Ordinary restarts use the enrolled identities and do not require an enrollment key.

On systemd installations, update the configured private credential files under `/etc/vpn-gateway/secrets`; supplying a new shell environment variable does not change an already-running controller. An upgrade accepts an explicit `TS_API_KEY_FILE` source path, validates and copies that private file into `/etc/vpn-gateway/secrets/tailscale-api-key`, and configures the controller to read it. Supplying an invalid source fails the upgrade; omitting the source preserves an existing API credential.

To enable the picker on an existing systemd deployment without running an upgrade, create `/etc/vpn-gateway/secrets/tailscale-api-key` with the API credential in a root-owned, singly linked regular file with mode `0400` or `0600`. Create or update the root-owned mode `0600` file `/etc/vpn-gateway/tailscale-api.env` so it contains this path, then restart the controller to load the setting:

```dotenv
TS_API_KEY_FILE="/etc/vpn-gateway/secrets/tailscale-api-key"
```

```bash
sudo systemctl restart vpn-gateway-controller.service
```

On Docker, credentials must be readable through their configured read-only mounts. If you replace a bind-mounted source file atomically, recreate the gateway with the guarded Compose wrapper so it sees the new file. Never paste keys into the administrator form or a command argument.

Administrator additions, removals, and default-exit changes restart the data plane and may briefly interrupt connections. Removing a published exit invalidates its cached connection profiles; users should refresh their subscriptions afterward. Removal does not delete its persistent identity directory or automatically remove the registered gateway device from Tailscale. Retire that unused device in the Tailscale administration console after any rollback window.

Health checks verify every configured exit, including its DNS path. If any exit fails, subscriptions return `503` until all remaining exits are healthy. The administration page continues to allow selecting a working default exit or removing failed additional exits during maintenance. When several exits are unavailable, remove them one at a time: each removal is saved while maintenance remains active, and readiness returns only when the remaining exits all pass their probes. There is no direct gateway egress fallback.

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

Finally, refresh a real client's subscription and compare its observed public IP with each selected Exit Node's egress IP. Select different exits on two clients at once and confirm their traffic follows their respective selections. Stop cloudflared and separately make any configured Exit Node or routed DNS unavailable: Tunnel loss must remove public reachability, while egress loss must keep subscriptions at `503`; neither failure may create direct VPS egress. Remove a failed additional exit through the administration page and confirm readiness recovers when all remaining exits are healthy. Confirm a removed exit's cached profile can no longer connect.

Repository tests and static configuration checks do not prove the external DNS, Cloudflare dashboard policy, provider firewall, origin reachability, or observed Exit-Node IP. Those live checks are intentionally not performed by this repository and remain required before production acceptance.
