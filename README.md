# Hardened multi-user VPN gateway

This project runs a multi-user VLESS + REALITY gateway. Every sing-box Internet dial triggered by an inbound has one egress: an embedded Tailscale (`tsnet`) endpoint using an approved Exit Node. That includes authenticated VPN traffic, the routed health probe, and REALITY's unauthenticated camouflage fallback. This is not a whole-host route: Tailscale control/DERP traffic, the controller's optional Tailscale API lookup, package updates, and other VPS processes still use host networking.

```text
Shadowrocket / VLESS client
          |
          | VLESS + REALITY over TCP 443
          v
    sing-box on the VPS
          |
          | embedded, persistent Tailscale endpoint
          v
    approved Exit Node -> Internet

    loopback subscription service :8080
    loopback admin HTTP backend   :8081
              |
              v
       root-owned controller
          over a typed Unix socket

    operator browser -> trusted local TLS frontend
                     -> SSH Unix-socket forward -> :8081
```

VPN users are not added to the tailnet. They receive an independent VLESS UUID and a high-entropy subscription token. A fresh installation has no VPN users; the administrator creates each user explicitly.

## Security and failure model

The generated server configuration has exactly one final route: the embedded Tailscale endpoint. It deliberately has no direct or fallback outbound. REALITY's handshake dialer is also required to use `detour: ts-out`, so an unauthenticated fallback connection cannot direct-dial the camouflage origin from the VPS or choose an arbitrary destination. If the selected Exit Node, Tailscale session, configuration, or routed health check fails, the controller leaves a maintenance marker in place and subscriptions return `503`; it does not silently send traffic from the VPS address.

Destination names from the public VLESS and health inbounds use a fixed DNS transport to `1.1.1.1:53/udp` with `detour: ts-out`; the health inbound therefore resolves the REALITY origin through the Exit Node. A separate local resolver bootstraps the embedded Tailscale endpoint's coordination/DERP connections and resolves names handed directly to that endpoint. In particular, REALITY's handshake fallback uses the endpoint resolver even though its resulting TCP dial is forced through `ts-out`. This DNS exception uses host networking and is not a direct traffic fallback.

Before the final route, ordered rules resolve public/health inbound domains through that routed resolver and reject private, loopback, link-local, multicast, CGNAT (`100.64.0.0/10`), Tailscale ULA (`fd7a:115c:a1e0::/48`), and other special-use destinations. This blocks ordinary attempts to use a VLESS credential as a path into Tailnet peers or private subnet routes. Those inbound rules do not process the REALITY handshake fallback, and an application cannot distinguish a globally routable prefix advertised into Tailscale from the same prefix on the Internet. A dedicated no-peer/no-subnet Tailnet identity is therefore a mandatory boundary for both authenticated traffic and fallback.

Every persistent user or configuration change is transactional:

1. Build a strict schema-v2 state and immutable revision.
2. Render a minimal sing-box configuration and subscription projection.
3. Write a size/hash manifest and run `sing-box check` on the rendered candidate.
4. Enter maintenance mode, activate the candidate, and restart sing-box when the data plane changed.
5. Make an authenticated SOCKS connection through sing-box and the selected Exit Node to `SERVER_NAME:443`. The health inbound must resolve the hostname through `exit-dns`, so readiness proves exit-routed inbound DNS and a `ts-out` TCP path to that origin at that moment; REALITY fallback resolution remains the separate endpoint-resolver path described below.
6. Publish the candidate as current only after that routed probe succeeds. Otherwise, restore and probe the previous revision.

On startup, the committed `current` revision is authoritative; interrupted `runtime` pointer changes are reconciled to it. A routed runtime-recovery failure keeps the administration UI available so an administrator can select another validated Exit Node, while public subscriptions remain unavailable. Unsafe or unreadable repository state aborts startup instead of exposing a repair surface over untrusted state.

After startup, the root controller repeats the authenticated routed probe every 30 seconds on both deployment paths. A dead sing-box process or lost exit-routed path latches maintenance and blocks subscriptions; the next watchdog pass attempts the same serialized recovery. If the controller cannot create or validate the maintenance marker, it terminates the whole application so a writable subscription surface cannot outlive the fail-closed authority. This internal gate is distinct from Docker's external container health status.

The repository also separates privileges:

- The controller is the only root-side state authority. Its Unix-socket protocol accepts fixed, typed operations—not paths, shell commands, service names, or arbitrary configuration.
- sing-box runs as `vpn-runtime`; it can read only its rendered runtime configuration and write its private Tailscale state.
- The subscription process runs as `vpn-sub`; it reads only the subscription-serving projection (active UUIDs, high-entropy token hashes, labels, and public client parameters), never canonical state, the REALITY private key, administrator material, or Tailscale credentials.
- The administration process runs as `vpn-admin`; it reaches the controller through a group-restricted Unix socket.
- The administration site is script-free and uses an independent administrator secret, scrypt verification, at most 64 in-memory sessions with a 30-minute idle/eight-hour absolute lifetime, exact HTTPS Host/Origin allowlists, login throttling, per-session operation limits, CSRF tokens that rotate after mutations, `Secure`/`HttpOnly`/`SameSite=Strict` `__Host-` cookies, clickjacking defenses, strict request limits, and generic error responses. Sessions disappear when the controller restarts. Browser access requires a trusted TLS frontend; the loopback HTTP listener is only a backend transport.

## Prerequisites

For either deployment method, prepare:

- A VPS with a public IPv4 address, IPv6 address, or DNS name and control of its network firewall/security group.
- A Tailscale device that is authorized, advertises a default route, and has that Exit Node route approved in the Tailscale admin console.
- A one-time Tailscale auth key that assigns exactly a dedicated gateway tag, such as `tag:vpn-gateway`. An untagged/user-owned identity or a tag shared with other workloads is not acceptable for this deployment. The key does not need to be embedded in `.env` or passed on a command line.
- A deny-by-default Tailnet policy for that tag: grant it use of `autogroup:internet` through Exit Nodes, but do not grant it any Tailnet peer, device, service, or advertised-subnet destination. Audit broad wildcard rules that might include the tag. The local destination filter is defense in depth, not a replacement for this policy boundary.
- Optionally, a current Tailscale API access token or OAuth bearer access token capable of reading the device directory. This enables the validated Exit Node picker and is strongly recommended because it is also the degraded-mode repair path. The gateway does not exchange an OAuth client ID/secret or refresh an expiring access token; an external process or operator must refresh the root-owned file.
- An operator-authorized, stable TLS origin for `SERVER_NAME`; check that both `1.1.1.1` and the VPS host resolver return only intended globally routable addresses and that the origin accepts TCP 443 from the Exit Node. Unauthenticated REALITY connections are forwarded only to this fixed name through the Exit Node, but endpoint-level resolution means DNS changes or rebinding still matter. Do not use an unrelated third-party site merely because it is a convenient camouflage target.
- Accurate system time and VPS outbound access to Tailscale control/DERP/direct connectivity and the optional Tailscale API. The selected Exit Node must be able to reach the REALITY origin on TCP 443, `1.1.1.1` on UDP 53 for routed destination DNS, and user destinations.
- A locally trusted TLS frontend for browser administration, using a dedicated non-localhost DNS name and a certificate/private key unavailable to `vpn-sub`. The documented workstation Caddy-over-SSH flow satisfies this without publishing the admin backend.

The standard Docker build pins Node 24.20.0, Go 1.26.7, Alpine 3.24, and sing-box 1.13.21, and verifies the exact sing-box build-tag set `with_gvisor,with_utls,with_tailscale`.

The bare-metal installer does not download dependencies. Install Node.js 24.20.0 or newer in the Node 24 line and exactly sing-box 1.13.21 at `/usr/bin` or `/usr/local/bin`; this is the audited version and the installer rejects substitutions. The sing-box binary must include both `with_tailscale` and `with_utls`. The host must also provide `/usr/bin/systemd-notify`.

```bash
node --version
sing-box version
```

Define the dedicated tag in the Tailnet policy before generating the auth key, and make the key apply that tag. Granting `autogroup:internet` permits Exit Node use; granting the Exit Node's Tailscale address merely permits a connection to that device and is neither required nor safe here. Current Tailscale policy cannot restrict `autogroup:internet` permission to one specific Exit Node, so the gateway configuration selects the intended approved node while Tailnet policy keeps peers and subnet routes inaccessible. Review Tailscale's [Exit Node access guidance](https://tailscale.com/docs/features/exit-nodes/how-to/setup) and [tag guidance](https://tailscale.com/docs/features/tags), then test the effective policy before exposing TCP 443.

## Docker deployment

### 1. Create host-side secret files

Create secrets outside the repository. The container rejects empty files, symlinks, non-root ownership, and modes other than `0400` or `0600`.

```bash
sudo install -d -o root -g root -m 0700 /etc/vpn-gateway-docker
sudo install -o root -g root -m 0600 /dev/null /etc/vpn-gateway-docker/tailscale-auth-key
read -r -s -p 'Tailscale auth key: ' TS_KEY; printf '\n'
printf '%s' "$TS_KEY" | sudo tee /etc/vpn-gateway-docker/tailscale-auth-key >/dev/null
unset TS_KEY
```

For the optional Exit Node directory credential:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/vpn-gateway-docker/tailscale-api-key
read -r -s -p 'Tailscale API/OAuth credential: ' TS_API; printf '\n'
printf '%s' "$TS_API" | sudo tee /etc/vpn-gateway-docker/tailscale-api-key >/dev/null
unset TS_API
```

### 2. Configure and start

```bash
cp .env.example .env
chmod 0600 .env
```

Edit `.env`. It contains paths and non-secret bootstrap settings, never the secret values themselves. Remove or leave `TS_API_KEY_FILE` empty if the optional API bearer file was not created:

```dotenv
TS_AUTH_KEY_FILE=/etc/vpn-gateway-docker/tailscale-auth-key
TS_API_KEY_FILE=/etc/vpn-gateway-docker/tailscale-api-key
EXIT_NODE=100.64.0.10
VPS_HOST=vpn.example.com
SERVER_NAME=replace-with-an-authorized-origin.example
NODE_NAME=vps-reality
PUBLIC_BASE_URL=
ADMIN_ALLOWED_HOSTS=admin.vpn.invalid:8444
ADMIN_ALLOWED_ORIGINS=https://admin.vpn.invalid:8444
```

`VPS_HOST` is written into client profiles and may be an unbracketed IPv4 address, unbracketed IPv6 address, or DNS name. `EXIT_NODE` is the initial Tailscale address or machine name. `PUBLIC_BASE_URL`, when set, must be an HTTPS URL on port 443 with no credentials, query, or fragment; setting it does not create a reverse proxy. The example `admin.vpn.invalid` name is deliberately non-resolving until the operator maps it to a trusted local TLS frontend.

Replace the reserved `SERVER_NAME` placeholder with an operator-authorized TLS origin before starting. `EXIT_NODE`, `VPS_HOST`, `SERVER_NAME`, and `NODE_NAME` are bootstrap inputs. Once a `current` pointer exists, revision state is authoritative and editing those values does not overwrite it. Keep `EXIT_NODE`, `VPS_HOST`, and `SERVER_NAME` syntactically present because Compose requires them while parsing the file. Use the admin UI for supported Exit Node and public-base changes; changing the public gateway host, REALITY identity/target, or tsnet hostname requires a planned fresh deployment because no live operation exposes those fields. `TS_AUTH_KEY_FILE` is also bootstrap-only after enrollment; `TS_API_KEY_FILE` and the two admin Host/Origin allowlists remain live process configuration.

Start and verify:

```bash
docker compose config >/dev/null
docker compose up -d --build
docker compose ps
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
```

The image uses a read-only root filesystem, drops all capabilities before adding only those needed to initialize ownership and supervise lower-privilege children, needs neither privileged mode nor `/dev/net/tun`, and stores all mutable data in the `vpn-data` volume. The host mappings are:

- Host TCP 443 on Docker's default all-interface bind to the container's VLESS listener on `8443/tcp`.
- `127.0.0.1:8080` to subscriptions.
- `127.0.0.1:8081` to the administration HTTP backend transport.

Never browse or directly forward the raw administration mapping. Browser cookies are not scoped by port, and browsers give localhost names special Secure-cookie handling. Administration therefore rejects IP, bare/suffixed localhost, single-label, and non-HTTPS origins and always emits `Secure` `__Host-` cookies. Use the trusted TLS-over-SSH workflow below.

### 3. Save the administrator secret and retire bootstrap secrets

The raw administrator secret is generated once and is not logged:

```bash
docker compose exec -T vpn-gateway cat /data/admin-secret
```

Put it in a password manager and confirm that it works before deleting this recovery copy. The controller stores only its scrypt record. There is currently no online administrator-secret reset, so losing the only remaining copy means rebuilding or restoring the control state. After that explicit check, retire the file with:

```bash
docker compose exec -T vpn-gateway rm -- /data/admin-secret
```

After the routed health check succeeds, the controller commits a new revision with both the Tailscale enrollment key and API credential removed from state, restarts from that scrubbed revision, and removes superseded credential-bearing revisions. The API secret file remains the live source for the Exit Node directory.

Once you have also confirmed that `/data/tailscale` is populated and backed up:

1. Revoke or expire the one-time auth key in Tailscale.
2. Remove `TS_AUTH_KEY_FILE` from `.env` so Compose binds `/dev/null` on later starts.
3. Remove the host auth-key file.
4. Recreate the container and run the health check again.

Delete `/data/admin-secret` only after testing the password-manager copy. Volume snapshots and old v1 files may retain earlier secret material; handle those separately under the backup and migration guidance below.

To rotate the optional API bearer file, replace the host file and recreate the container so the file bind mount cannot retain the old inode:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/vpn-gateway-docker/tailscale-api-key.new
read -r -s -p 'New Tailscale API bearer: ' TS_API; printf '\n'
printf '%s' "$TS_API" | sudo tee /etc/vpn-gateway-docker/tailscale-api-key.new >/dev/null
unset TS_API
sudo mv -- /etc/vpn-gateway-docker/tailscale-api-key.new /etc/vpn-gateway-docker/tailscale-api-key
docker compose up -d --force-recreate
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
```

### Docker upgrades

Take a cold volume backup first, retain the previously built image under a separate tag, then rebuild and recreate:

```bash
docker image tag vpn-gateway:local vpn-gateway:rollback
docker compose build --pull
docker compose up -d
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
```

Compose preserves the named data volume only when the Compose project name is unchanged. Keep using the same directory or an explicit, stable `docker compose -p NAME`; otherwise Compose can create an empty volume that merely has the same logical `vpn-data` label. Compose does not provide application-aware rollback. A new image can automatically advance the stored v2 policy described below, after which merely starting the old image against the changed volume is not a safe rollback; restore the matching cold pre-upgrade volume with the retained image. Never use `docker compose down -v` unless permanent deletion of all gateway state is intended.

## Bare-metal deployment with systemd

The installer supports Debian and Ubuntu hosts booted with systemd. It creates `vpn-runtime`, `vpn-sub`, and `vpn-admin`, installs the application in `/opt/vpn-gateway`, keeps configuration under `/etc/vpn-gateway`, and stores authoritative state under `/var/lib/vpn-gateway`.

Before it creates an account, writes deployment state, or stops an existing service, the installer enumerates the host's NSS users and groups. It refuses UID/GID aliases, unexpected primary or supplementary group members, login-capable service accounts, and unlocked passwords for these three privilege boundaries. Resolve any collision explicitly instead of adding operators to `vpn-runtime`, `vpn-sub`, or `vpn-admin`.

For an interactive first installation:

```bash
sudo bash server/install.sh
```

The installer prompts for the auth key, initial Exit Node, public gateway host, required operator-authorized REALITY origin, node name, optional HTTPS subscription base, and optional Tailscale API credential. Secret input is copied into root-owned `0600` files.

For non-interactive installation, pass secret file paths and required settings explicitly:

```bash
sudo env \
  TS_AUTH_KEY_FILE=/root/provisioning/tailscale-auth-key \
  TS_API_KEY_FILE=/root/provisioning/tailscale-api-key \
  EXIT_NODE=100.64.0.10 \
  VPS_HOST=vpn.example.com \
  SERVER_NAME=replace-with-an-authorized-origin.example \
  NODE_NAME=vps-reality \
  PUBLIC_BASE_URL=https://subscriptions.example.com \
  bash server/install.sh
```

Omit `TS_API_KEY_FILE` and `PUBLIC_BASE_URL` if unused. Replace the reserved `SERVER_NAME` placeholder in the example; on a fresh non-interactive install, `TS_AUTH_KEY_FILE`, `EXIT_NODE`, `VPS_HOST`, and an operator-authorized `SERVER_NAME` are required.

Each supplied secret source must be an absolute path to a non-empty, singly linked `root:root` regular file with mode `0400` or `0600`. The installer opens it without following symlinks and verifies that the pathname still names the same inode after the bounded read. Keep provisioning files below a root-only directory such as `/root/provisioning`; an insecure or concurrently replaced source is rejected rather than copied.

The installed services are:

- `vpn-gateway-controller.service`: root controller and transaction authority.
- `vpn-gateway-sing-box.service`: `vpn-runtime` data plane on TCP 443.
- `vpn-gateway-subscription.service`: `vpn-sub` service on `127.0.0.1:8080`.
- `vpn-gateway-admin.service`: `vpn-admin` site on `127.0.0.1:8081`.
- `vpn-gateway.target`: starts and stops the complete set.

Retrieve and protect the first administrator secret:

```bash
sudo cat /var/lib/vpn-gateway/admin-secret
```

After saving and testing it, remove that plaintext copy with `sudo rm -- /var/lib/vpn-gateway/admin-secret`. Its later absence is expected: an upgrade preserves the credential verifier and state but does not recreate the retired recovery copy. After routed readiness is confirmed and `/var/lib/vpn-gateway/tailscale` is backed up, revoke the enrollment auth key and remove `/etc/vpn-gateway/secrets/tailscale-auth-key`. The service no longer needs it because the controller has scrubbed it from committed state and tsnet uses its persistent node state.

Keep `/etc/vpn-gateway/secrets/tailscale-api-key` if the Exit Node picker is required. The controller reads it for each directory request, so replacing the file updates the credential without putting it in revision state. If adding the picker later, create that file as `root:root` mode `0600`, ensure `/etc/vpn-gateway/tailscale-api.env` contains exactly:

```dotenv
TS_API_KEY_FILE="/etc/vpn-gateway/secrets/tailscale-api-key"
```

Then restart `vpn-gateway-controller.service` and check readiness.

When rotating an already configured bearer, write a new root-owned `0600` file beside the old one and rename it over `/etc/vpn-gateway/secrets/tailscale-api-key`. No service restart is required because each directory request reopens that path. Never put an OAuth client secret there; store the already-issued bearer access token.

### Bare-metal upgrades and rollback

Run the same installer from the new source tree:

```bash
sudo bash server/install.sh
```

When v2 pointers already exist, the installer first saves the installed application, environment directory, and unit files under a new root-only `/var/backups/vpn-gateway/upgrade-*` directory. It then stops the old service set, validates and snapshots the entire canonical `revisions/` namespace, and journals both pointer targets (or their absence) and whether the maintenance marker was present. The snapshot is deliberately bounded to at most 32 revisions and 64 MiB of protected revision files; an unsafe or oversized namespace aborts the upgrade before replacement code starts. The replacement controller has a 330-second systemd startup/stop ceiling. After all services report active, the installer makes at most 45 final routed-health attempts separated by two seconds; each health-check command has its own nine-second controller deadline.

Only one installer may run at a time: it holds an exclusive lock on the validated root-owned `/run/vpn-gateway-installer.lock` inode for its full lifetime. Before stopping anything, it durably records the prior active/enabled state and temporarily disables both possible v2 boot entry points. After the protected revision snapshot is durable, a second journal records the exact restore staging and quarantine names. A rerun after power loss or `SIGKILL` reconciles these journals before normal installation: it either restores the pre-handoff service state or finishes the exact namespace/program rollback. Do not delete either journal, its referenced backup, or a failed-revision quarantine to force progress; preserve them and investigate any validation failure.

Before successful handoff, any installer failure stops the replacement, atomically swaps the complete saved revision namespace back into place, restores both pointers and the exact prior maintenance state, and restores the program/environment/unit files. The failed release's complete revision namespace—including new pointed or orphan revisions—is retained in a root-only mode-`0700` quarantine at `/var/lib/vpn-gateway/.failed-upgrade-revisions.*`; its path is recorded in the upgrade backup. A completed rollback journal is archived inside that quarantine so replay cannot restore over revisions legitimately appended by the recovered controller. The installer restores the target's enabled state and starts the full prior target when any v2 unit had been active before the upgrade. This rewinds every canonical revision change made during the failed upgrade, including an automatic policy conversion or credential scrub, but deliberately does not rewind mutable Tailscale state, audit records, or other non-revision files below `/var/lib/vpn-gateway`.

The installer rollback bundle is not a full state backup: its protected-state journal contains the complete pre-upgrade revision namespace, pointer targets, and maintenance state, but not Tailscale state, audit records, migration material, or every other state-root file. Take a separate cold state backup before every upgrade. A successful upgrade retains the installer backup for manual rollback. After a failed upgrade, preserve the recorded quarantine while diagnosing the failure; it can contain newly generated credentials or other sensitive candidate state. Restore an installer backup only with the v2 services stopped and only when its code is compatible with the current state schema; otherwise restore the matching full cold backup onto a clean host.

Treat every retained `/var/backups/vpn-gateway/upgrade-*` bundle as secret material. After the rollback window, move the one bundle you intentionally retain into encrypted, access-controlled storage and securely retire older bundles so repeated upgrades do not accumulate credential-bearing snapshots on the VPS.

## Automatic upgrade of narrowly recognized previous v2 policies

At bootstrap, before the controller socket, web services, or data plane are published, the code can recognize only four narrowly bounded, manifest-authenticated predecessor renderer generations:

1. The initial v2 renderer with the sole `ts-out` final route but without explicit routed destination DNS/endpoint bootstrap DNS, and with the REALITY detour absent in the earliest form.
2. The immediately following renderer with `exit-dns`, the endpoint bootstrap resolver, and the REALITY `ts-out` detour, but without the ordered private/Tailnet/special-use rejection rules.
3. The immediately prior isolation renderer with those three ordered rules but the exact, narrower special-use CIDR list that preceded the current IANA expansion.
4. The immediately prior expanded isolation renderer, differing only by omission of the well-known NAT64 prefix that the current policy rejects.

For any recognized shape, bootstrap creates a `policy.upgrade` revision, forces the readiness target to the existing REALITY origin on TCP 443, renders the current fixed-DNS and destination-rejection policy, validates it with the installed sing-box, and atomically selects it as both `runtime` and `current`. It preserves user credentials, REALITY keys, the selected Exit Node, and the persistent Tailscale identity. The controller then starts the data plane, proves routed DNS/TCP readiness, and retires predecessor-policy revisions before publishing readiness.

This is deliberately not a general state migrator. An older, modified, unmanifested, or authority-expanding shape—including one with an added direct outbound—is rejected and remains fail closed. Take a cold backup before installing new code and look for `Upgraded VPN gateway state revision` in startup logs. The resulting manifest operation is `policy.upgrade`, although an immediately required `credentials.scrub` can become the next current revision. Do not run `bootstrap.js` manually against a live service set.

## Administration and user lifecycle

The administration backend is intentionally bound to loopback and speaks HTTP only as a private transport. It is not a browser endpoint. Browser cookies are host-scoped rather than port-scoped, and localhost has special Secure-cookie behavior, so a raw HTTP port forward would let a compromised subscription process solicit an admin cookie on another port.

Use a dedicated non-localhost name, a locally trusted TLS frontend on the operator workstation, and an SSH Unix-socket forward. The included `server/operator-admin.Caddyfile` expects `admin.vpn.invalid:8444`; map `admin.vpn.invalid` to `127.0.0.1` in the workstation's hosts file or local resolver. From the repository on the workstation, create a private directory and start the tunnel:

```bash
install -d -m 0700 "$PWD/.vpn-admin-tunnel"
ssh -N \
  -L "$PWD/.vpn-admin-tunnel/backend.sock":127.0.0.1:8081 \
  operator@vpn.example.com
```

In a second workstation terminal, run a locally installed Caddy process with its private state outside the repository:

```bash
VPN_ADMIN_SOCKET="$PWD/.vpn-admin-tunnel/backend.sock" \
  caddy run --config server/operator-admin.Caddyfile
```

Caddy's internal CA must be trusted by the browser profile; run `caddy trust` if its automatic trust installation did not succeed. Verify the certificate chain without bypassing a warning, then open `https://admin.vpn.invalid:8444`, sign in, and use the dashboard. The example frontend supplies HSTS, preserves the exact external Host, and has no TCP route to subscriptions. Caddy documents both [local HTTPS trust](https://caddyserver.com/docs/automatic-https#local-https) and [reverse-proxy header behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers). Keep the local CA private and stop both processes when the session ends.

The `ADMIN_ALLOWED_HOSTS` and `ADMIN_ALLOWED_ORIGINS` settings must use a dedicated DNS hostname with one matching `https://` origin per Host; bare/suffixed localhost, IP addresses, single-label names, HTTP origins, trailing dots, and mismatched pairs are rejected. The cookie is always Secure; there is no insecure compatibility switch. An older checkout must replace its localhost/IP/HTTP settings before this release will start. Do not forward the raw backend to a browser, reuse the admin name for subscriptions, bypass certificate errors, or put both services under different paths of one origin.

Supported lifecycle operations are:

- Create a user. A new UUID and 256-bit URL-safe subscription token are generated. The raw token, VLESS link, and—when a public base is configured—subscription URL are displayed once.
- List active, disabled, and recent revoked records. Up to 256 users may remain active or disabled. New-user creation compacts old revoked tombstones to the newest 256, and the dashboard shows the most recent 64 revoked records.
- Disable a user. The UUID is removed from the active sing-box configuration and the subscription token stops resolving.
- Re-enable a disabled user with its existing credentials.
- Rotate only the subscription token. The old URL stops resolving; the existing VLESS UUID remains valid.
- Rotate the UUID and subscription token atomically. Both the old client profile and old subscription URL stop working after the candidate passes readiness.
- Export the current VLESS link for an active user. The raw subscription token cannot be recovered.
- Revoke a user permanently after typing the display name. Revoked records are immutable and cannot be re-enabled.
- Select an Exit Node from the validated Tailscale directory and update the optional public subscription base.

Except for token-only rotation and public-base changes, lifecycle changes alter the sing-box data plane and can cause a brief restart. Concurrent/stale browser submissions are rejected by revision number. In degraded mode, all mutations except selecting a validated replacement Exit Node are blocked.

User creation and both credential-rotation actions return secrets that cannot later be reconstructed from state. The built-in administration page/control client assigns each one a UUID operation ID and automatically retries one controller-transport failure with the identical request under the original 300-second absolute deadline. After a successful commit, the controller keeps the one-time response in memory for at most five minutes, capped at four results per administrator session and never beyond that session's lifetime. A same-session retry with the same ID and exact operation fields returns the cached raw token without another commit, after checking it still authenticates the same active user and rebuilding the link, public URL, revision, and CSRF value from current authority. Unrelated concurrent commits therefore do not destroy recoverability; if a later status or credential change superseded that token, retry fails with an idempotency-stale conflict. Reusing the ID with different fields returns an idempotency conflict.

This cache is never written to revision state, audit files, or disk, but controller memory temporarily contains the returned raw credentials. Logout, session expiry/eviction, or controller shutdown/crash destroys the cache and session. If the response was lost across that boundary, sign in again, inspect which mutation committed, and perform another credential rotation; the original token cannot be recovered.

Both credential rotations apply only to active users. Migration intentionally keeps the v1 user's UUID and token working for continuity. At the credential cutover, use the combined rotation, capture its one-time replacement output immediately, and distribute it through a secure channel; both legacy bearers stop working when that revision commits.

### Subscription endpoints

For a raw token shown at creation or rotation, the read-only endpoints are:

| Format | Path |
| --- | --- |
| Base64-encoded VLESS link | `/s/TOKEN` |
| Plain VLESS link | `/s/TOKEN/links` |
| Full sing-box client JSON | `/s/TOKEN/sing-box` |
| Clash Meta / Mihomo YAML | `/s/TOKEN/clash` |

For a trusted one-off subscription fetch, create a separate SSH TCP forward to `127.0.0.1:8080` and use a non-browser client against that local port; do not give it the administration hostname. For remote delivery, proxy the subscription service through HTTPS and configure `PUBLIC_BASE_URL`; a value such as `https://subscriptions.example.com/vpn` causes generated URLs below `/vpn/s/`, so the reverse proxy must strip or map that prefix to the backend's `/s/` route.

Subscription requests accept only `GET` and `HEAD`, no query string, and return `404` for unknown, disabled, revoked, or rotated tokens. The service returns no administration page and never receives controller access.

## HTTPS reverse proxy guidance

The documented workstation TLS frontend over an SSH Unix-socket forward is the default administration path. The stock gateway already consumes TCP 443 on all VPS addresses, while `PUBLIC_BASE_URL` permits only HTTPS on port 443. A conventional HTTPS reverse proxy therefore cannot also bind that VPS port. For remotely published subscriptions or administration, use an external HTTPS frontend with an authenticated private tunnel back to the appropriate loopback service, or a separately designed and tested layer-4 SNI multiplexer. Multiplexing is not included here and must pass REALITY through without TLS termination; do not improvise it during an incident.

If a reverse proxy is used:

- Keep ports 8080 and 8081 bound to host loopback. Never publish the controller socket or `/var/lib/vpn-gateway`/`/data`.
- Give administration and subscriptions distinct HTTPS origins and exact virtual hosts, routed exclusively to their respective backends before any application content is served. Never place them below different paths of one origin or use the administration hostname for subscriptions on any port.
- Serve the administration site at the virtual host root; its routes and cookie path do not support mounting beneath a URL prefix.
- Set `ADMIN_ALLOWED_HOSTS` to the exact external Host header, for example `admin.example.com`, and `ADMIN_ALLOWED_ORIGINS` to the exact origin, for example `https://admin.example.com`. Values are comma-separated and literal; include a non-default port when one appears in the browser URL.
- Use a certificate chain trusted by the browser, enable HSTS, and keep the frontend's admin certificate/private key inaccessible to `vpn-sub`. Never bypass a certificate warning. The application always emits Secure `__Host-` cookies and refuses HTTP or localhost origins.
- Do not expose or browse the raw HTTP backend, including through a TCP SSH forward. The workstation workflow uses a Unix socket so only the trusted TLS terminator can reach it locally.
- Preserve the external `Host` and browser `Origin` headers. The application does not trust `X-Forwarded-Host` or `X-Forwarded-For`.
- Strip the `Cookie` header before forwarding every subscription request (for example, `proxy_set_header Cookie "";` in the subscription location). Do not strip cookies from the administration upstream.
- Configure TLS, request/body limits, timeouts, and an additional authentication or network-access layer at the proxy.
- Redact `/s/TOKEN` paths from proxy, CDN, analytics, and observability logs. A subscription URL is a bearer credential.

For Docker, edit the two admin Host/Origin values in `.env` and run `docker compose up -d --force-recreate`. For bare metal, edit the existing root-only `/etc/vpn-gateway/admin.env` with `sudoedit`, keep it mode `0600`, and restart only the administration process with `sudo systemctl restart vpn-gateway-admin.service`. In either case, verify the certificate, HSTS, login, and rejected incorrect Host/Origin requests through the actual frontend before relying on it. Use `healthcheck.js`, not an unauthenticated HTTP route, for routed health.

Forwarded client IP headers are intentionally ignored. After a projection match, each valid subscription token receives an independent bounded bucket keyed by its one-way digest; invalid guesses share a separate source bucket and cannot fill or spend the valid-token table, while a malformed-request guard applies only before credential matching. The valid table is larger than the maximum active-user count. Administration's ordinary and mutation limits are likewise keyed by a one-way session digest only after the controller validates that session; its source-wide guard applies only to unauthenticated or invalid traffic, so fake cookies and anonymous floods cannot spend an authenticated administrator's bucket. Apply aggregate and stricter per-client limits at the trusted proxy: only that layer can safely attribute public clients after replacing spoofable forwarding headers, and invalid-token throttling inside the service occurs after the bounded projection read needed to distinguish a real token.

## Ports and firewall

Only the VLESS data plane should be reachable from the public Internet.

| Port | Bind | Purpose | Public? |
| --- | --- | --- | --- |
| TCP 443 | all addresses | VLESS + REALITY | Yes |
| TCP 8080 | `127.0.0.1` | subscription files | No |
| TCP 8081 | `127.0.0.1` | administration | No |
| TCP 19080 | `127.0.0.1` inside the runtime | authenticated SOCKS readiness probe | No |

Allow the chosen SSH management port from trusted source ranges and TCP 443 from intended users. Deny 8080, 8081, and 19080 in both the cloud security group and host firewall. Docker publishes 8080/8081 only on loopback, but still verify them from another host. Docker documents that Engine releases older than 28.0.0 allowed peers on the same layer-2 network to reach localhost-published ports; non-default direct-routing or unprotected bridge modes can also invalidate simple bind assumptions. See Docker's [port-publishing guidance](https://docs.docker.com/engine/network/port-publishing/).

VPS outbound filtering must accommodate Tailscale control, DERP/STUN/direct connectivity, the optional Tailscale API, and host DNS needed only to establish those paths. Proxied destination DNS (`1.1.1.1:53/udp`), the REALITY origin/readiness target, and user destinations are reached from the selected Exit Node through `ts-out`, so its firewall policy must permit them. Follow Tailscale's current [firewall guidance](https://tailscale.com/docs/reference/faq/firewall-ports) rather than assuming one fixed UDP port list.

## Exit Nodes, IPv4, IPv6, and DNS

- The public sing-box inbound uses a dual-stack `::` socket. Confirm the host kernel and provider actually make both address families reachable; publishing an IPv6 address in `VPS_HOST` does not create IPv6 connectivity.
- Client links bracket IPv6 literals correctly. Supply `VPS_HOST` without brackets.
- The Exit Node picker accepts only authorized Tailscale devices whose advertised and enabled routes include `0.0.0.0/0` or `::/0`, whose device identifier/hostname is valid, and which has a Tailscale IPv4 address in `100.64.0.0/10` or a Tailscale IPv6 address under `fd7a:115c:a1e0::/48`.
- When both are present, the picker stores the Tailscale IPv4 address; otherwise it uses the validated IPv6 address.
- The optional API/OAuth credential is directory-only. If it is missing, expired, or lacks access, the picker is unavailable rather than accepting arbitrary text. The initial `EXIT_NODE` remains the bootstrap value.
- Fresh-install `EXIT_NODE` is syntax-validated but is not cross-checked against the API directory; the operator must verify its authorization and approved default route in the Tailscale admin console. Later dashboard selections are restricted to the freshly validated directory.
- Directory lookup has a five-second/1 MiB response bound, examines at most the first 512 returned devices, and displays at most 128 validated Exit Nodes. A very large tailnet can therefore omit a valid device rather than weaken these limits.
- sing-box gives the embedded Tailscale endpoint a host-local bootstrap resolver for its coordination/DERP path and for names handed directly to the endpoint, including the REALITY handshake fallback. The public VLESS and health inbounds instead use the fixed `1.1.1.1:53/udp` transport through `ts-out`; there is no direct DNS fallback for those inbound destination names and no runtime setting to replace that resolver.
- Filtering order is security-significant: domains from the public and health inbounds are resolved through `exit-dns`; `ip_is_private` rejects private, loopback, link-local, multicast, and related non-public results; an explicit CIDR rule then rejects CGNAT/Tailscale and additional special-use ranges; only surviving destinations reach the final `ts-out` route. Literal IP destinations enter the same rejection rules without needing resolution.
- The explicit additional IPv4 blocks are `0.0.0.0/8`, `100.64.0.0/10`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.2/32`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, and `240.0.0.0/4`. The IPv6 blocks are `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `100:0:0:1::/64`, `2001::/32`, `2001:2::/48`, `2001:10::/28`, `2001:db8::/32`, `2002::/16`, `3fff::/20`, `5f00::/16`, and Tailscale `fd7a:115c:a1e0::/48`. Rejecting the standard and local-use NAT64 prefixes avoids relying on an Exit Node translator to refuse embedded private IPv4 destinations. Network-specific translation prefixes cannot be enumerated here, so keep the gateway tag denied from peer and subnet resources as the independent control for globally routable advertised prefixes and for the REALITY fallback, which bypasses these inbound route rules.
- The routed health probe resolves and connects to the configured REALITY origin on TCP 443 through the selected Exit Node, proving the gateway's exit-routed DNS and TCP path. It does not prove client-side DNS behavior, IPv6 egress, geolocation, throughput, or every destination; test those separately from a real client.
- Generated profiles route client traffic to VLESS, but DNS behavior also depends on the client application and operating system. Configure Shadowrocket or another client to send DNS through the proxy if local resolver leakage is unacceptable, then verify with a DNS leak test you trust.

The Tailscale API response is treated as untrusted input and bounded before parsing. A node must have its default route both advertised and enabled; merely appearing in the tailnet is insufficient.

The fixed resolver is an availability and privacy dependency: UDP/53 blocking or interception between the Exit Node and `1.1.1.1` breaks routed domain resolution and therefore REALITY-origin readiness, while DNS queries are not encrypted by this transport. Do not use a split-horizon or private-only `SERVER_NAME`; the health inbound rejects private/special-use answers. The fallback may see a different answer from the endpoint's host-local resolver, so keep the gateway tag unable to reach Tailnet peers/subnets and monitor both DNS views. A successful health probe is a point-in-time observation, not a defense against a later DNS change or rebinding event.

## Persistent Tailscale identity and re-enrollment

The Tailscale endpoint is non-ephemeral and stores its node identity in the deployment's `tailscale` directory. According to the sing-box Tailscale endpoint behavior, `auth_key` is ignored once a node already exists in that state directory. Consequently:

- Replacing or restoring `TS_AUTH_KEY_FILE` does not re-enroll an existing node.
- A tagged replacement auth key also does not retag an identity already stored in this directory. For a v1 migration or restored backup, assign and verify the dedicated gateway tag on the existing machine record in the Tailscale admin console before cutover; do not delete state to force the change.
- Deleting the Tailscale state after bootstrap will not transparently recover, because the committed revision intentionally no longer contains an auth key.
- Never delete, partially copy, or edit the Tailscale state while the service is running.
- Treat state loss as disaster recovery: restore a matching cold backup. For deliberate re-enrollment, provision a fresh data root/volume with a new auth key, create and distribute replacement user credentials, validate it, and cut over. There is no supported in-place re-enrollment operation.

See the upstream [sing-box Tailscale endpoint documentation](https://sing-box.sagernet.org/configuration/endpoint/tailscale/) and [Tailscale auth-key guidance](https://tailscale.com/docs/features/access-control/auth-keys).

## State, audit, backup, and recovery

The authoritative state root is `/data` in Docker and `/var/lib/vpn-gateway` on bare metal. Important entries include:

```text
current -> revisions/<committed-id>       authoritative committed revision
runtime -> revisions/<running-id>         configuration selected for sing-box
revisions/<id>/state.json                 root-only canonical state
revisions/<id>/sing-box.json              runtime projection
revisions/<id>/subscription-view.json     group-readable subscription-serving projection
revisions/<id>/manifest.json              sizes and SHA-256 digests
tailscale/                                persistent tsnet node identity
maintenance                               present while subscriptions must fail closed
audit.jsonl                               bounded mutation audit
audit.jsonl.previous                      one rotated audit generation
admin-secret                              one-time plaintext recovery copy, if not retired
legacy-backups/                           private v1 source backups after migration
.legacy-migration-in-progress/            bare-metal resumable migration journal, normally absent
.legacy-migration-committed               bare-metal migration handoff marker, after a v1 migration
.upgrade-restart-in-progress/              pre-stop bare-upgrade intent journal, normally absent
.upgrade-rollback-in-progress/             bare-metal resumable upgrade journal, normally absent
.upgrade-rollback-retired.*/               transient committed-journal retirement, normally absent
.failed-upgrade-revisions.*/              failed bare-upgrade quarantine and completed rollback journal
```

The repository retains at most 32 revisions and 64 MiB by default while protecting the committed and selected runtime revisions. Audit files rotate at roughly 1 MiB. Subscription tokens are stored only as SHA-256 hashes, so a backup can preserve whether an already-known token works but cannot reveal a lost token.

### Backup rules

Back up the state root, root-only environment/secret files, the exact application version, and the external copy of the administrator secret. Authenticated encryption at rest and strict access control are mandatory: backups contain VLESS UUIDs, the REALITY private key, the administrator verifier, and the Tailscale device identity. Migration backups and older snapshots may also contain raw retired Tailscale or subscription credentials. The examples below assume `/mnt/encrypted-backups` is a mounted, verified encrypted destination; replace it with your encrypted backup system and do not run them against an ordinary unencrypted filesystem. The repository defensively ignores common archive names, but an ignore rule is not encryption.

Stop the complete service set before copying mutable Tailscale state.

For Docker, one cold archive method using the already-built image is:

```bash
backup_file=/mnt/encrypted-backups/vpn-gateway/vpn-data.tgz
install -d -m 0700 "$(dirname "$backup_file")"
install -m 0600 /dev/null "$backup_file"
docker compose stop vpn-gateway
docker compose run --rm --no-deps --entrypoint tar vpn-gateway \
  -C /data -czf - . > "$backup_file"
docker compose start vpn-gateway
gzip -t "$backup_file"
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
unset backup_file
```

For bare metal:

```bash
sudo systemctl stop vpn-gateway.target
sudo install -d -o root -g root -m 0700 /mnt/encrypted-backups/vpn-gateway
sudo install -o root -g root -m 0600 /dev/null \
  /mnt/encrypted-backups/vpn-gateway/bare-state.tgz
sudo tar --acls --xattrs --numeric-owner -C / \
  -czf /mnt/encrypted-backups/vpn-gateway/bare-state.tgz \
  etc/vpn-gateway \
  var/lib/vpn-gateway \
  opt/vpn-gateway \
  etc/systemd/system/vpn-gateway.target \
  etc/systemd/system/vpn-gateway-controller.service \
  etc/systemd/system/vpn-gateway-sing-box.service \
  etc/systemd/system/vpn-gateway-subscription.service \
  etc/systemd/system/vpn-gateway-admin.service
sudo gzip -t /mnt/encrypted-backups/vpn-gateway/bare-state.tgz
sudo systemctl start vpn-gateway.target
sudo node /opt/vpn-gateway/src/healthcheck.js
```

If the service cannot be stopped, use a storage snapshot mechanism that provides an application-consistent filesystem snapshot; copying the live `tailscale` directory is not sufficient.

Restore into an empty volume or clean host with the same service UID/GID ownership, application version, and state schema. Do not overlay an archive onto a running or partially initialized deployment. Ensure the original gateway identity is offline before starting the restored `tailscale` directory; two running copies of one node identity are unsafe. Validate the archive before extraction, start the controller/service set, and require the routed health check before reopening TCP 443. Test this restore process periodically on an isolated host with no route to production; an untested archive is not a recovery plan.

Do not edit revision JSON or repoint `current`/`runtime` manually during ordinary recovery. The controller performs rollback automatically, and bootstrap reconciles an interrupted runtime pointer to the committed revision. If both pointers are absent while any canonical revision remains, bootstrap reports `ORPHANED_REVISION` before reading bootstrap credentials or generating a replacement identity; this prevents a crash boundary from silently creating a second authority. Preserve that entire state root and restore the matching pointers only as part of a verified full cold backup—never delete the revisions or reinitialize in place. If repository ownership, manifests, or pointers are otherwise rejected as unsafe, restore a verified cold backup rather than bypassing the checks.

## Legacy v1 migration

Never run v1 and v2 sing-box services against the same port or Tailscale state simultaneously. Take a cold backup of `/etc/vpn-sub.env`, `/etc/sing-box/config.json`, the legacy Tailscale state directory, service units, and sudoers rule before starting.

### Bare-metal v1 migration

The installer recognizes the standard v1 pair:

- `/etc/vpn-sub.env`
- `/etc/sing-box/config.json`

Both must be present, regular files, and internally consistent. Preview first:

```bash
sudo env MIGRATE_LEGACY=dry-run bash server/install.sh
```

The preview parses only an allowlisted legacy environment syntax and prints the normalized migration summary. It does not source the legacy shell file, write v2 gateway state, or stop/modify legacy services. Review the public host and ports, REALITY server name, Tailscale hostname/state directory, Exit Node, and migrated user label. Migration preserves the old REALITY origin but renders the current `ts-out` handshake detour, fixed routed DNS, ordered destination rejection, and origin-bound readiness target; legacy direct/fallback authority is not carried forward. If you are not authorized to use that origin, or either `1.1.1.1` or the VPS host resolver does not return only intended public addresses, do not apply the migration—perform a planned fresh deployment with an approved origin instead.

Apply only after review:

```bash
sudo env MIGRATE_LEGACY=1 bash server/install.sh
```

For an interactive run, leaving `MIGRATE_LEGACY` unset requires typing the literal confirmation shown by the installer.

The installer preserves legacy auth/API credentials in root-only v2 secret files, verifies source digests again after stopping the old services, copies and byte-compares the standard `/var/lib/sing-box/tailscale` tree, validates a second preview against the copied path, creates the schema-v2 revision, and saves the original environment/config plus a checksum manifest under `/var/lib/vpn-gateway/legacy-backups/v1-*`. It disables the old `sing-box.service` and `vpn-sub.service` only after migration, and removes the known legacy passwordless sudo rule only after routed readiness succeeds.

If the legacy configuration names a nonstandard Tailscale state directory, the installer refuses to guess. Stop legacy writers, securely pre-copy and verify that tree at `/var/lib/vpn-gateway/tailscale`, then rerun with `LEGACY_STATE_PRECOPIED=1` as instructed by the error.

Before v2 handoff, installer failure restores the old services' prior active/enabled state. The root-only `/var/lib/vpn-gateway/.legacy-migration-in-progress` directory records the reviewed source digests, prior service state, and completed copy/publication stages so an exact-input rerun can safely resume. After routed readiness succeeds, the installer atomically creates `/var/lib/vpn-gateway/.legacy-migration-committed` before crossing the handoff boundary, then removes the in-progress work. If that cleanup is interrupted, the committed marker makes the next installer run treat the host as v2 and finish cleanup rather than replay migration. The committed marker remains as provenance; do not delete, edit, or fabricate either marker.

For a manual rollback after a successful handoff, stop and disable `vpn-gateway.target` before enabling either legacy service, restore the legacy sudoers rule if its control helper is still required, and use a consistent cold backup of the legacy state. A delayed rollback may reuse a stale copy of the same Tailscale device identity; assess that identity in the admin console and never run both copies concurrently.

After the rollback window closes, move the original v1 files and `legacy-backups` into encrypted offline retention or securely retire them. They can contain raw subscription, REALITY, auth, and API credentials even though v2 revisions have been scrubbed.

### Docker v1 migration

The standard old container stored `/data/env`, `/data/config.json`, and `/data/tailscale` in the same named volume used by v2. Stop v1 and take a cold volume backup. Configure the new `.env`, and verify that the Compose project name still resolves `vpn-data` to the old volume rather than a newly created empty one. If the old environment had a Tailscale API token, copy it into the new root-owned host secret file and configure `TS_API_KEY_FILE` before applying; otherwise the controller will scrub the migrated in-state copy and the Exit Node picker will have no live credential.

Run the migration function in preview mode without starting the services:

```bash
docker compose build
docker compose run --rm --no-deps --entrypoint sh vpn-gateway \
  -c 'test -f /data/env && test -f /data/config.json && test -d /data/tailscale && test -n "$(find /data/tailscale -mindepth 1 -print -quit)"'
MIGRATE_LEGACY=dry-run docker compose run --rm --no-deps \
  -e TS_API_KEY_FILE= \
  --entrypoint node vpn-gateway \
  --input-type=module --eval \
  'import { bootstrap } from "/app/src/bootstrap.js"; console.log(JSON.stringify(await bootstrap(), null, 2))'
```

The explicit empty API-file override keeps preview independent of the optional `/dev/null` secret mount; the legacy API value is still parsed and redacted from the summary. Require the preview's `tailscaleStateDirectory` to be exactly `/data/tailscale`. On apply, the normal entrypoint independently extracts that value from the legacy JSON, rejects any other path, and rejects an empty or unsafe Tailscale tree before changing ownership or invoking bootstrap. Remove the API-file override for the normal apply so a configured external API bearer becomes the live post-migration authority.

Review the output, then apply and start:

```bash
MIGRATE_LEGACY=1 docker compose up -d --build
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
```

This automatic Docker path is only for the exact, non-empty `/data/tailscale` layout. Stop and investigate a custom or empty legacy state path instead of allowing a new Tailscale identity to be created. After acceptance, remove `MIGRATE_LEGACY` from `.env`, retain the cold backup for the rollback period, and then handle `/data/env`, `/data/config.json`, and `/data/legacy-backups` as sensitive retired material.

If Docker migration fails or must be rolled back, stop v2 first. Do not start the v1 image against a volume that v2 has already used: restore the entire pre-migration volume or provider snapshot into an empty volume, verify that the restored `/data/tailscale`, `/data/env`, and `/data/config.json` belong to the same backup point, and only then start the pinned v1 image. Never run the v1 and v2 volumes containing the same restored Tailscale identity at the same time.

A rollback also restores the legacy UUID and subscription token. Treat them as valid again until the v1 service is permanently retired, even if a later v2 revision had rotated them.

## Operations and troubleshooting

### Service lifecycle

Use the complete service set for planned maintenance; the controller owns sing-box restarts during transactions.

```bash
# Docker
docker compose stop vpn-gateway
docker compose start vpn-gateway
docker compose restart vpn-gateway

# Bare metal
sudo systemctl stop vpn-gateway.target
sudo systemctl start vpn-gateway.target
sudo systemctl restart vpn-gateway.target
```

Allow the stop to finish rather than killing the processes: shutdown drains accepted one-time credential responses and the deployment permits up to 330 seconds for the longest bounded recovery, credential-scrub, and rollback path. The controller reasserts maintenance after its in-flight mutation/watchdog queue drains. After every start or restart, require `healthcheck.js` to succeed before declaring the data plane available; the same routed check then repeats internally every 30 seconds.

### Status, logs, and health

Docker status and logs:

```bash
docker compose ps
docker compose exec -T vpn-gateway node /app/src/healthcheck.js
docker compose logs --tail=200 vpn-gateway
```

Bare-metal status and logs:

```bash
systemctl status \
  vpn-gateway-controller.service \
  vpn-gateway-sing-box.service \
  vpn-gateway-subscription.service \
  vpn-gateway-admin.service
sudo node /opt/vpn-gateway/src/healthcheck.js
sudo journalctl -u vpn-gateway-controller.service -u vpn-gateway-sing-box.service --since '30 minutes ago'
```

`healthcheck.js` talks to the controller, confirms the committed/runtime relationship, checks that sing-box is active, and exercises the authenticated loopback SOCKS probe through the configured final Tailscale route. Exit status zero means the routed TCP check succeeded; no output is expected. There is deliberately no unauthenticated administration health route that can queue a recovery or restart; monitor with this local command or the container health status.

When subscriptions return `503`, inspect controller and sing-box logs, the gateway's dedicated tag/effective Tailnet policy, device authorization, Exit Node route approval, Exit Node access to `1.1.1.1:53/udp`, and DNS/TCP reachability of the REALITY origin on port 443. The readiness target is fixed to that origin; there is no separate health destination to relax during an incident. Use the administration dashboard to select a different validated Exit Node. Do not delete the maintenance marker by hand: doing so bypasses only subscription suppression, not the failed routed path.

## Manual VPS acceptance checklist

Complete this from both the VPS and an external client before declaring the gateway ready:

- [ ] Confirm the installed Node version, exact sing-box 1.13.21 version, and both required `with_tailscale` and `with_utls` build tags.
- [ ] Confirm `SERVER_NAME` is an operator-authorized TLS origin and the rendered REALITY handshake contains `detour: ts-out`; test fallback behavior only against that approved origin.
- [ ] Confirm the cloud firewall and host firewall expose only the chosen SSH port and TCP 443.
- [ ] Confirm `ss -lntp` shows subscriptions/admin on loopback only and the health listener is not public.
- [ ] Confirm all four services are active (or the Docker container is healthy) and `healthcheck.js` exits zero repeatedly.
- [ ] Confirm the gateway device is authorized and online in Tailscale, the intended Exit Node routes are approved/enabled, and no duplicate gateway identity is online.
- [ ] Confirm the gateway uses its dedicated Tailscale tag and cannot connect to any Tailnet peer or advertised subnet under current ACLs/grants.
- [ ] Confirm the tag can use `autogroup:internet`, routed queries reach `1.1.1.1:53/udp`, private/CGNAT/Tailscale/special-use test destinations are rejected, and the approved REALITY origin resolves only to intended public addresses through both `1.1.1.1` and the VPS host resolver and accepts TCP 443 from the Exit Node.
- [ ] Confirm the first successful recovery scrubbed enrollment/API credentials from current revision history; keep only the external API file if the picker is needed.
- [ ] Save and test the administrator secret, then retire its plaintext state-root copy and the one-time Tailscale auth-key file.
- [ ] Open administration only through a certificate-valid, HSTS-enabled TLS frontend over the SSH Unix-socket tunnel (or an equivalently isolated frontend); confirm the raw HTTP backend is not browser-reachable and incorrect Host/Origin requests are rejected.
- [ ] Verify administration and subscriptions use distinct HTTPS origins and exclusive virtual-host routing, the admin certificate key is unavailable to `vpn-sub`, and the subscription proxy strips `Cookie` before forwarding.
- [ ] Create a test user and save the one-time token, VLESS link, and subscription URL outside logs/screenshots.
- [ ] Fetch all four subscription formats and import the intended format into Shadowrocket or another REALITY-capable client.
- [ ] Connect from outside the VPS network and confirm the observed IPv4 egress is the Exit Node, not the VPS.
- [ ] If IPv6 is required, confirm IPv6 destinations use the Exit Node; absence of a client IPv6 route must not fall back outside the VPN.
- [ ] Run a DNS leak test with the client's intended DNS settings and confirm resolvers match policy.
- [ ] Disable the test user and verify both new connections and its subscription URL stop working; re-enable and verify recovery.
- [ ] Rotate the token and verify the old URL returns `404`. Rotate both credentials and verify the old URL and old VLESS profile fail while the newly displayed credentials work.
- [ ] Revoke the test user and verify it cannot be re-enabled.
- [ ] Restart the complete service/container after auth-key retirement and confirm persistent Tailscale identity and routed readiness survive.
- [ ] Inspect proxy/application logs for the known test token and secrets; configure redaction or retention changes if any appear.
- [ ] Create a cold encrypted backup, restore it in an isolated environment, and repeat the health and identity checks.

## Development and validation

There are no npm runtime dependencies. With Node 24.20.0 or newer in the Node 24 line:

```bash
npm test
bash -n server/install.sh
sh -n docker/entrypoint.sh
sh -n server/sing-box-wrapper.sh
EXIT_NODE=100.64.0.10 VPS_HOST=vpn.example.com \
  SERVER_NAME=replace-with-an-authorized-origin.example \
  docker compose config >/dev/null
```

The test suite covers strict validation, credentials and lifecycle transitions, renderer fail-closed invariants (including routed DNS, ordered destination rejection, and the REALITY fallback detour), the narrowly allowlisted bootstrap policy upgrades, immutable repository/pointer behavior, migration, exit-directory validation, runtime restart and routed probes, Unix-socket framing/permissions, HTTP hardening, degraded recovery, credential scrubbing, and transaction rollback. Unit/integration tests use fakes for real Tailscale and public networking; they do not replace the VPS acceptance checklist or exercise the bare-metal installer's systemd rollback on a real host.

## Threat model and remaining infrastructure risks

The design reduces privilege and prevents several dangerous failure modes, but it is not a substitute for host and tailnet security.

- A root, kernel, Docker-daemon, or storage-backup compromise can recover all server-side credentials and alter the running binary.
- The fail-closed route constrains sing-box inbound dials, not the entire VPS. The embedded Tailscale control plane, Tailscale directory API, reverse proxies, package managers, and unrelated host processes can still contact the network using the VPS address; enforce their policy with host/container egress controls.
- A VLESS UUID and subscription URL are bearer credentials. There is no device attestation, per-device binding, traffic quota, billing, or abuse detection.
- The deliberately unprivileged `vpn-sub` process must read the complete active subscription projection so it can authenticate path tokens and render profiles without a privileged request broker. Compromise of that process therefore exposes every active VLESS UUID and permits local availability attacks, although it does not reveal raw subscription tokens, administrator/REALITY/Tailscale secrets, or controller access. Treat such a compromise as an all-user UUID incident: rotate affected UUIDs (or both credentials), redistribute profiles, and investigate the host. Stronger per-request credential isolation would require a separate authenticated controller broker or per-user encrypted records and is not implemented.
- The administrator credential currently has no online rotation. Loss requires a surviving external copy or a matching recovery backup; disclosure requires a planned fresh deployment and user reprovisioning because restoring the same state preserves the compromised verifier.
- REALITY disguises and protects the client-to-VPS transport; traffic beyond the Exit Node has only the destination protocol's protection. A compromised Exit Node can observe metadata and plaintext application traffic.
- The Tailscale account, ACL/grants policy, device approval, OAuth scopes, and Exit Node itself remain external trust dependencies. A globally routable prefix advertised as a subnet route is indistinguishable from the Internet destination at the application layer; the dedicated gateway identity must therefore have no peer/subnet grants. Use least privilege, MFA, expiry/rotation, and alerts.
- Tailnet policy grants Exit Node use through `autogroup:internet`, not a particular Exit Node. The application pins the configured/selected approved device, but an administrator, compromised controller, or Tailnet control-plane change can select another authorized Exit Node.
- Routed inbound-destination DNS is fixed, unencrypted UDP to `1.1.1.1` through the Exit Node. Resolver outage, blocking, interception, or an origin's private/split-horizon answer makes readiness unavailable by design; there is no direct fallback for public/health inbound DNS.
- The default health check proves the configured routed resolver and one TCP path to the REALITY origin. It cannot prove client-side DNS policy, arbitrary destinations, public reachability, IPv6, performance, censorship resistance, or the expected geographic egress IP.
- Unauthenticated REALITY fallback is restricted to the fixed `SERVER_NAME:443` name and routed through the Exit Node, so the client cannot choose an arbitrary destination. It is still abuse-sensitive: scanners can make the gateway create traffic to that name, whose endpoint-level lookup uses the host resolver and bypasses the public/health inbound rejection rules. A compromised resolver, split-horizon change, or DNS rebinding can therefore steer fallback toward a Tailnet-reachable address if Tailnet policy grants one; the dedicated tag's no-peer/no-subnet rule is mandatory. Use only an origin you operate or are explicitly authorized to use, monitor/rate-limit it, and reassess its DNS, behavior, and ownership.
- Cloud firewalls, Docker rules, reverse proxies, NAT, kernel IPv6 settings, provider anti-abuse controls, and port-443 conflicts can invalidate repository-level assumptions.
- Subscription tokens in URL paths can leak through browser history, screenshots, proxy/CDN logs, support tickets, or copied command output. Prefer direct client provisioning or a dedicated HTTPS endpoint with redacted logs.
- Because forwarded addresses are untrusted and the bundled services see a loopback proxy peer, they cannot reject an exhausted source bucket before determining whether a presented token/session is valid without also locking out legitimate users. Invalid requests are response-throttled and cannot spend verified credential buckets, but rotating guesses can still consume bounded projection reads or controller session checks. The trusted frontend must impose per-client connection, concurrency, and request-rate limits before exposing either service; repository-level throttles are fairness and memory controls, not complete denial-of-service protection.
- The browser administration boundary depends on its TLS frontend, local/private CA trust, DNS/hosts mapping, exact virtual-host routing, and private admin certificate key. A shared origin, raw backend port, ignored certificate warning, compromised operator workstation, or frontend that routes the admin hostname to subscription content defeats that boundary.
- Removing persistent Tailscale state is destructive. An expired enrollment key does not affect an already enrolled node, but it also cannot repair lost state after the credential-free revision is committed.

Review upstream changes before updating Node, sing-box, Tailscale behavior, container bases, or systemd policy. In particular, preserve the required `with_tailscale` and `with_utls` build features, persistent non-ephemeral endpoint, sole final route, dedicated no-peer/no-subnet Tailnet identity, fixed exit-routed destination DNS, resolve-before-reject ordering, REALITY handshake `detour: ts-out`, authenticated health inbound targeting the REALITY origin, and post-restart routed readiness gate.
