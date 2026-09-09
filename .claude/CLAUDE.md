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

`cloudflared` runs in its own container sharing the gateway's network namespace. Every listener is loopback-only and asserted as such in code; nothing is published to the host.

### Authority lives in one place

`GatewayController` (`src/control/authority/controller.js`) is the only writer of state. It holds sessions, serializes all mutations through `queueMutation` (a promise tail) and all logins through `queueLogin`. The HTTP admin process is a *view*: it holds no sessions, no state, and no secrets — it forwards to the controller with `src/control/socket/client.js`.

The transport is a bounded **one-request-per-connection NDJSON Unix socket** (`src/control/socket/server.js`, `protocol.js`). Filesystem permissions on the socket *are* the authentication boundary; there is no in-band transport auth. Errors returned across it are flattened to a code/status pair with a generic message, so never expect detail to survive the hop.

Request handling is layered: `src/control/requests/dispatch.js` separates reads from writes, and `mutations.js` applies replay-idempotency, CSRF and revision checks before delegating to `users.js` or `gateway.js` in the same directory. `contract.js` owns request validation, replay fingerprints and operation errors.

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

- **Canonical** `state.json` — `src/core/model/state.js`, `STATE_SCHEMA_VERSION = 3`. Contains secrets (scrypt admin record, Tailscale keys while present).
- **Projection** `subscription-view.json` — `src/core/subscriptions/view.js`, `SUBSCRIPTION_VIEW_SCHEMA_VERSION = 2`. Credential-minimized; users appear only as `sha256:` token hashes.

The subscription process reads *only* the projection file, re-validating it on every request, and never contacts the controller. `src/core/subscriptions/clients.js` renders the four public formats (mixed, `links`, `sing-box`, `clash`) from the projection alone.

Schema v3 is the only supported format. `src/state/bootstrap/service.js` selects first-run initialization or current-format recovery, with secret reads isolated in `bootstrap/secrets/`. Unsupported state is **rejected, never converted or overwritten**. Do not reintroduce migration code.

### Exit nodes

One default exit plus up to `MAX_EXTRA_EXITS = 15` published exits, all selectable by any user in their own client. Per-exit user credentials are *derived*, not stored: `deriveExitUuid(userUuid, exitId)` and `deriveExitHealthPassword` in `src/core/identity/exit-profiles.js` are HMACs, and `exitId` is a truncated SHA-256 of the Tailscale device id. This derivation is a persistent client credential contract — changing it invalidates every deployed client profile.

### Credential lifecycle

Tailscale enrollment keys are read from root-owned files at their moment of use, written into a protected candidate revision, and scrubbed by `retireBootstrapCredentials()` before readiness is published. That function then scans *all* revisions and deletes any other one still carrying enrollment credentials, so an interrupted scrub is safely retryable. Secrets never enter `.env`, argv, or logs; `.env` holds paths only.

### Admin HTTP

`__Host-`-prefixed Secure/HttpOnly/SameSite=Strict cookies, a separate login-CSRF cookie, strict `Host`/`Origin` canonicalization against `ADMIN_PUBLIC_HOSTNAME`, and four independent rate limiters (global, per-session, login, mutation). Mutations carry `expectedRevision` for optimistic concurrency and an `operationId` for replay-safe credential issuance; CSRF rotates after every commit.

## Conventions and traps

**Strict allow-lists at every boundary.** `exactObject`/`expectExactKeys`/`exactForm` reject unknown *and* missing keys. Adding one admin form field means updating the matching form in `src/http/admin/pages/`, `exactForm(...)` in `src/http/admin/routes.js`, the client method in `src/control/socket/client.js`, the request contract and per-operation checks in `src/control/requests/`, and the operation handler. New operations also need the client's `ALLOWED_OPERATIONS` entry. Miss one and the request fails with a generic error and no useful message.

**Authority classes.** `RevisionRepository` and `GatewayController` delegate to the modules that own filesystem, revision, session and transaction behavior, passing the instance as their first argument. Add behavior in the owning module and keep class wiring small. Import each public function from its owner; do not introduce forwarding modules at retired paths.

**Source structure has hard limits.** Every file under `src/` must be at most **200 physical lines**, including comments and blank lines. Every source directory, including `src/`, may have at most **8 direct entries**, counting files and subdirectories together. There are no exceptions; `npm run check:structure` reports all violations without writing files. Split by responsibilities and preserve validation and ordering at each boundary.

**Five CLI paths stay stable.** Keep `src/control/controller-server.js`, `src/http/admin-server.js`, `src/http/subscription-server.js`, `src/runtime/healthcheck.js`, and `src/state/bootstrap.js`. Internal modules move with their consumers; do not add compatibility shells.

**Layout is asserted by tests.** `test/integration/deployment-layout.test.js` pins Dockerfile digests, pinned tool versions and Compose security properties; `test/ci/verify-image-contents.sh` compares the image's `/app/src` against the source tree recursively. Moving or renaming a `src/` file requires updating consumers by direct relative import (no compatibility shims at retired paths), plus npm scripts, systemd units, Docker paths, and — for a file that ever shipped — the enumerated retired-file list in `deploy/systemd/installer/source-installation.sh` so upgrades remove it inside the existing backup/rollback transaction.

**Deployment scripts import owning modules, not launchers** — e.g. `bootstrap` from `src/state/bootstrap/service.js` and `readSecretFile` from `src/state/bootstrap/secrets/files.js`. Keep CLI execution at `src/state/bootstrap.js`.

**Tests are grouped by behavior, not by file.** Reuse `test/fixtures/state.js` for synthetic state and `test/fixtures/controller.js` for an isolated repository + fake runtime; `test/helpers/` holds HTTP setup. Fixtures inject determinism (fixed `now`, seeded `randomBytes`) rather than mocking modules.

Version pins (`sing-box 1.13.21` with `with_tailscale`/`with_utls`, `cloudflared 2026.8.3`, the Node base image digest, OpenSSL package versions) live in the Dockerfiles, which are the source of truth; `docs/development.md` describes the dependency-update procedure.
