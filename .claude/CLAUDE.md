# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A multi-user VLESS-over-WebSocket gateway. Cloudflare Tunnel is the only public ingress; an embedded Tailscale `tsnet` stack inside sing-box is the only egress. Node 24, ESM, **zero runtime dependencies and no lockfile** — everything is `node:` stdlib. Do not add npm dependencies without an explicit decision to change that.

`docs/development.md` is the authoritative contributor guide (repository layout, where new files belong, per-module responsibilities, CI details). Read it before adding or moving files. This file covers what that guide assumes you already know.

## Commands

```bash
npm test                                   # full suite: node --test "test/**/*.test.js"
npm run check:structure                     # source line and directory-entry limits
node --test test/unit/lifecycle.test.js    # one file
node --test test/unit/ test/http/          # one category
node --test --test-name-pattern='^root repository fixes' test/unit/repository.test.js

npm start            # controller server (needs deployment config + initialized state)
npm run bootstrap    # initialize state from env
npm run healthcheck  # probe a running gateway over its control socket
```

There is no JavaScript linter or formatter. CI runs `npm run check:structure` before `node --check` on every `src`/`test` JS file, plus `shellcheck` (`bash test/ci/validate-shell.sh`) and `gofmt`/`go vet` on `deploy/docker/cloudflared-guard.go`. Longer CI checks live in `test/ci/*.sh`; run them from the repository root.

**Environment caveats**, both of which cause tests to pass locally and fail in CI:

- `engines` pins `node >=24.20.0 <25`; this machine runs v25. The suite mostly works, but Node 24.20.0 is what CI and production use.
- Tests asserting Linux ownership and service/deployment behavior self-skip off Linux or off root (`test/unit/repository.test.js`, `test/integration/source-layout-upgrade.test.js`, `installer-supported-state.test.js`, `exit-credential-upgrade.test.js`). A green macOS run proves nothing about them. CI runs them again under `sudo`.

## Architecture

### Process topology

One root controller process supervises everything. `src/control/controller-server.js` → `src/control/app/application.js` builds the app, then:

- spawns **sing-box** (`SupervisedSingBoxRuntime` in `src/runtime/sing-box/supervised.js` for Docker, `SystemdSingBoxRuntime` in `systemd.js` for bare metal) listening on `127.0.0.1:8443`
- spawns two unprivileged HTTP children via `src/control/app/web-processes.js` — subscription (uid 11001, `127.0.0.1:8080`) and administration (uid 11002, `127.0.0.1:8081`) — each with a scrubbed env, both keeping the application root as cwd
- serves a root-owned Unix socket at `CONTROLLER_SOCKET`, group-owned by the admin gid

`cloudflared` runs in its own container sharing the gateway's network namespace. Public deployments keep every listener loopback-only and publish nothing to the host. The explicit `docker-compose.local.yml` override enables local HTTP, binds the administration service to the container interface, and publishes only host `127.0.0.1:8081`; it does not enable the Tunnel profile. The internal subscription worker remains loopback-only in both modes.

### Authority lives in one place

`GatewayController` (`src/control/authority/controller.js`) is the only writer of state. It holds sessions, serializes all mutations through `queueMutation` (a promise tail) and all logins through `queueLogin`. The HTTP admin process is a *view*: it holds no sessions, no state, and no secrets — it forwards to the controller with `src/control/socket/client.js`.

There are two session realms, both in the controller: `controller.sessions` (administrator, issued by `auth.login`) and `controller.accountSessions` (end users, issued by `account.login`, 60 min idle / 24 h absolute / 512 max). They are separate `ControllerSessions` instances, so an id from one is a plain miss in the other. `src/control/authority/accounts.js` owns both sign-ins (one scrypt derivation per attempt — a dummy record for unknown names — and the failure delay outside the login tail) and the account realm helpers; `account.*` operations resolve the acting user from the session subject; `account.check` is an in-memory gate, and every data-bearing operation re-checks that the user still exists, is active and has a password before acting. Sessions end eagerly on disable, revoke, UUID rotation, admin password reset and (other devices) self password change.

The transport is a bounded **one-request-per-connection NDJSON Unix socket** (`src/control/socket/server.js`, `protocol.js`). Filesystem permissions on the socket *are* the authentication boundary; there is no in-band transport auth. Errors returned across it are flattened to a code/status pair with a generic message, so never expect detail to survive the hop.

Request handling is layered: `src/control/requests/dispatch.js` separates reads from writes and routes `account.*` to `accounts.js`; `mutations.js` applies replay-idempotency, CSRF and revision checks before delegating to `users.js` or `gateway.js` in the same directory. `contract.js` owns request validation, replay fingerprints and operation errors. Account mutations carry no `expectedRevision` and no replay id: re-running a lost `account.rotateToken` or `user.resetPassword` simply issues a fresh secret, so neither retries transport.

### Two-pointer immutable revision repository

`src/state/repository.js` delegates to `src/state/filesystem/` and `src/state/revisions/`. It stores immutable revisions under `$DATA_DIR/revisions/<id>/` with four files: `manifest.json`, `state.json`, `sing-box.json`, `subscription-view.json`. Two atomic pointers select revisions:

- `current` — what subscriptions publish
- `runtime` — what sing-box is actually running

They diverge only inside a transaction. `runtime` moves first, `current` last.

### Transactions are fail-closed

`transact()` in `src/control/authority/runtime-transactions.js` is the write path, and every step matters:

1. create candidate revision
2. validate `sing-box.json` with the **real sing-box binary** (`sing-box check`)
3. `setMaintenance(true)`
4. `activateRuntime(candidate)` → restart sing-box → **probe the routed data path**
5. `activateCurrent(candidate)` → `setMaintenance(false)`

Any failure rolls both pointers back, restarts, re-probes, removes the candidate, and appends an audit record with `rolled-back` or `rollback-failed`. Publication is never re-opened unless a probe passed.

The `$DATA_DIR/maintenance` marker file is the fail-closed switch. `src/http/subscription/application.js` checks it **before and after** loading the projection, because a transaction can swap `current` mid-request. A 30s watchdog in `src/control/app/lifecycle.js` re-probes and drops into maintenance on failure. There is deliberately no fallback egress: a broken exit means `503`, never traffic out the gateway's own IP.

Readiness probing (`src/runtime/health/readiness.js` → `websocket-probe.js` + `socks-probe.js`) exercises the real path: a WebSocket upgrade against the VLESS listener, then an authenticated SOCKS5 CONNECT per published exit to `EGRESS_HEALTH_HOST:443`. `socks-codec.js` owns SOCKS message encoding and reply sizing. Adding exits adds parallel probes under one shared deadline.

### Canonical state vs public projection

Two schemas, deliberately separated:

- **Canonical** `state.json` — `src/core/model/state.js`, `STATE_SCHEMA_VERSION = 3`. Contains secrets (scrypt admin record, Tailscale keys while present, each user's optional portal-password scrypt record under `users[].password` — declared through `expectExactKeys(..., { optional })`, stripped from revoked tombstones, never projected, never rendered into sing-box).
- **Projection** `subscription-view.json` — `src/core/subscriptions/view.js`, `SUBSCRIPTION_VIEW_SCHEMA_VERSION = 2`. Credential-minimized; users appear only as `sha256:` token hashes.

The subscription process reads *only* the projection file, re-validating it on every request, and never contacts the controller. `src/core/subscriptions/clients.js` renders the four public formats (mixed, `links`, `sing-box`, `clash`) from the projection alone.

The administrator site proxies `/s/…` to that worker using `src/http/admin/subscriptions.js`, a fixed internal port and the canonical `ADMIN_PUBLIC_HOSTNAME` Host header. It never reads projections or takes the subscription UID/GID. The worker accepts that hostname and the stored subscription hostname. New public subscription URLs use the administration origin; preserve the canonical old subscription origin so historical URLs keep working. Only fresh initialization defaults an omitted subscription base to `https://ADMIN_PUBLIC_HOSTNAME`. The VPN WSS hostname remains separate.

Schema v3 is the only supported format. `src/state/bootstrap/service.js` selects first-run initialization or current-format recovery, with secret reads isolated in `bootstrap/secrets/`. Unsupported state is **rejected, never converted or overwritten**. Do not reintroduce migration code.

### Exit nodes

One default exit plus up to `MAX_EXTRA_EXITS = 15` published exits, all selectable by any user in their own client. Per-exit user credentials are *derived*, not stored: `deriveExitUuid(userUuid, exitId)` and `deriveExitHealthPassword` in `src/core/identity/exit-profiles.js` are HMACs, and `exitId` is a truncated SHA-256 of the Tailscale device id. This derivation is a persistent client credential contract — changing it invalidates every deployed client profile.

### Credential lifecycle

Tailscale enrollment keys are read from root-owned files at their moment of use, written into a protected candidate revision, and scrubbed by `retireBootstrapCredentials()` before readiness is published. That function then scans *all* revisions and deletes any other one still carrying enrollment credentials, so an interrupted scrub is safely retryable. Secrets never enter `.env`, argv, or logs; `.env` holds paths only.

### Usage accounting

sing-box is built with `with_v2ray_api` and the rendered config exposes its V2Ray stats service on loopback `STATS_LISTEN_PORT` (19081), tracking every public inbound credential. `src/runtime/stats/` talks to it with a hand-written HTTP/2 gRPC unary call and protobuf codec (no dependencies). `UsageTracker` (`src/control/authority/usage.js`) folds counter deltas into per-user lifetime totals in `$DATA_DIR/usage.json`; sing-box counters restart from zero on every restart, so `restartRuntime()` in `runtime-transactions.js` samples before each restart and clears the last-seen counters after it, the lifecycle watchdog samples after each healthy probe, and shutdown samples once more. Usage is derived data outside the revision repository and never affects readiness or authority.

### Admin HTTP

Public HTTPS uses `__Host-`-prefixed Secure/HttpOnly/SameSite=Strict cookies, a separate login-CSRF cookie, strict `Host`/`Origin` canonicalization against `ADMIN_PUBLIC_HOSTNAME`, and four independent rate limiters (global, per-session, login, mutation). Mutations carry `expectedRevision` for optimistic concurrency and an `operationId` for replay-safe credential issuance; CSRF rotates after every commit.

The end-user portal lives in the same process under `/account` (`src/http/account/`), branched in `application.js` before the administrator login and session pipeline. It has its own cookies (`__Host-vpn_account_session` / `__Host-vpn_account_login_csrf`, `*_local` variants in local mode), its own limiters (sign-in per source address 120/5 min — portal-wide behind the tunnel, where every client shares one address — and per normalized display name 10/10 min, authenticated 120/min, controller-bound mutations 6/10 min per session) and its own error handling that clears only the account cookie. The controller additionally budgets portal changes per user (`takeAccountBudget`, 6 per 10 min → `RATE_LIMITED` 429) and caps a user at eight sessions, because every portal change is a full fail-closed transaction. Portal pages render from `account.snapshot`; downloads map content types locally. Users created before accounts existed show "No portal password" until the administrator resets one.

`GET`/`HEAD` `/` is a constant public home page for everyone (`renderHomePage` in `src/http/admin/pages/access.js`, evaluated once in `application.js` and branched before any cookie is read): it spends only the anonymous global limiter, never calls the controller, never sets or clears a cookie, and links to `/account` and `/overview`, each of which redirects to its realm's sign-in when no session is presented. The administrator dashboard lives at `/overview`. `application.js` admits only `MANAGEMENT_PATHS` (exported by `src/http/admin/routes.js`) to the administrator pipeline and answers any other path 404 before reading a cookie; `test/integration/management-paths.test.js` pins that gate and ties the list to the deployment guide's Access layout, so a new administrator route must be added to the list. A listed path without an accepted administrator cookie 303s to `/login`; a presented cookie is verified with `checkSession` *before* any application budget is spent (the account realm does the opposite), and `test/http/admin-rate-limits.test.js` pins that order, so do not reorder it. Neither the account sign-in page nor the portal shell links to `/` (pinned by `test/http/account-auth.test.js` and `test/http/account-routes.test.js`), because a hostname-wide Access policy keeps `/` away from end users; the home page must stay argument-free so nothing dynamic can reach it.

`src/http/admin/site.js` validates the optional `LOCAL_HTTP_ORIGIN`: an exact canonical HTTP origin on `localhost`, `127.0.0.1`, or `[::1]`, without credentials, path, query or fragment. Local mode uses separate HTTP cookies and preserves Host/Origin and CSRF checks. Keep it disabled for public deployments. The Docker entrypoint permits a container-interface administration listener only after this explicit origin validates. systemd loads the public hostname and local origin from root-only `admin.env` for both HTTP identities without granting either additional filesystem access.

## Conventions and traps

**Strict allow-lists at every boundary.** `exactObject`/`expectExactKeys`/`exactForm` reject unknown *and* missing keys. Adding one admin form field means updating the matching form in `src/http/admin/pages/`, `exactForm(...)` in `src/http/admin/routes.js` or `user-routes.js`, the client method in `src/control/socket/client.js`, the request contract and per-operation checks in `src/control/requests/`, and the operation handler. New operations also need the client's `ALLOWED_OPERATIONS` entry and the master envelope allow-list in `dispatch.js`. Portal forms follow the same chain through `src/http/account/routes.js` (or `access.js` for sign-in) and `src/control/requests/accounts.js`; `account.*` envelopes never carry `userId` or `expectedRevision`. Miss one and the request fails with a generic error and no useful message.

**Authority classes.** `RevisionRepository` and `GatewayController` delegate to the modules that own filesystem, revision, session and transaction behavior, passing the instance as their first argument. Add behavior in the owning module and keep class wiring small. Import each public function from its owner; do not introduce forwarding modules at retired paths.

**Source structure has hard limits.** Every file under `src/` must be at most **200 physical lines**, including comments and blank lines. Every source directory, including `src/`, may have at most **8 direct entries**, counting files and subdirectories together. There are no exceptions; `npm run check:structure` reports all violations without writing files. Split by responsibilities and preserve validation and ordering at each boundary.

**Five CLI paths stay stable.** Keep `src/control/controller-server.js`, `src/http/admin-server.js`, `src/http/subscription-server.js`, `src/runtime/healthcheck.js`, and `src/state/bootstrap.js`. Internal modules move with their consumers; do not add compatibility shells.

**Layout is asserted by tests.** `test/integration/deployment-layout.test.js` pins Dockerfile digests, pinned tool versions and Compose security properties; `test/ci/verify-image-contents.sh` compares the image's `/app/src` against the source tree recursively. Moving or renaming a `src/` file requires updating consumers by direct relative import (no compatibility shims at retired paths), plus npm scripts, systemd units, Docker paths, and — for a file that ever shipped — the enumerated retired-file list in `deploy/systemd/installer/source-installation.sh` so upgrades remove it inside the existing backup/rollback transaction.

**Deployment scripts import owning modules, not launchers** — e.g. `bootstrap` from `src/state/bootstrap/service.js` and `readSecretFile` from `src/state/bootstrap/secrets/files.js`. Keep CLI execution at `src/state/bootstrap.js`.

**Tests are grouped by behavior, not by file.** Reuse `test/fixtures/state.js` for synthetic state and `test/fixtures/controller.js` for an isolated repository + fake runtime; `test/helpers/` holds HTTP setup. Fixtures inject determinism (fixed `now`, seeded `randomBytes`) rather than mocking modules.

Version pins (`sing-box 1.13.21` with `with_tailscale`/`with_utls`/`with_v2ray_api`, `cloudflared 2026.8.3`, the Node base image digest, OpenSSL package versions) live in the Dockerfiles, which are the source of truth; `docs/development.md` describes the dependency-update procedure.
