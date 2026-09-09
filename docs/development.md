# Development

Use Node.js `>=24.20.0 <25`, matching `package.json` and the deployment runtime. Run commands from the repository root.

## Repository layout

```text
src/
  core/
    validation/   values.js, hosts.js, ingress.js
    identity/     credentials.js, exit-profiles.js
    model/        state.js, settings.js, policy.js
    users/        records.js, mutation-context.js, lifecycle.js, credential-rotation.js
    server/       render.js, model.js, assert.js, single-exit.js, single-exit-state.js
    subscriptions/ view.js, clients.js
  control/
    controller-server.js
    app/          application.js, lifecycle.js, process-settings.js, web-processes.js
    authority/    controller.js, sessions.js, state-views.js, operational-files.js,
                  runtime-transactions.js
    requests/     contract.js, dispatch.js, mutations.js, users.js, gateway.js
    socket/       client.js, client-transport.js, server.js, files.js, protocol.js
  http/
    admin-server.js, subscription-server.js
    shared/       service.js, input.js, rate-limit.js
    admin/        application.js, auth.js, request.js, routes.js
      pages/      document.js, access.js, dashboard.js, users.js, exits.js
    subscription/ application.js, data.js
  runtime/
    healthcheck.js, tailscale.js
    sing-box/     config-check.js, supervised.js, systemd.js
    health/       readiness.js, socks-codec.js, socks-probe.js, websocket-probe.js
  state/
    bootstrap.js, repository.js
    bootstrap/    service.js, initialize.js, recovery.js, environment.js, errors.js
      secrets/    files.js, credentials.js
    filesystem/   files.js, policy.js, revision-directory.js
    revisions/    read.js, write.js, manifest.js, pointers.js, retention.js
deploy/
  docker/       Dockerfiles, container entry point, Compose launcher, Tunnel guard
  systemd/      Installer entry point, sing-box wrapper, service units and target
    installer/  Ordered installation, upgrade, backup, rollback and service phases
test/
  unit/         Individual modules and behavior
  http/         HTTP routes, clients, authentication, and response behavior
  integration/  Cross-module behavior, process wiring, and deployment guarantees
  fixtures/     Synthetic state and isolated repository/controller/installer setup
  helpers/      HTTP request and server setup shared by behavior tests
  ci/           Executable checks called by CI
docs/           Deployment, operations, and development guides
```

Keep Compose configuration, package metadata, environment examples, and tool configuration at the root. GitHub workflows and dependency-update configuration belong in `.github/`.

## Where new files belong

- Put domain rules that do not own persistence or network servers in the appropriate `src/core/` area: validation, identity, model, users, server, or subscriptions. Put filesystem access and immutable revisions in `src/state/filesystem/` and `src/state/revisions/`; initialization belongs in `src/state/bootstrap/`.
- Put control startup in `src/control/app/`, serialized authority in `authority/`, authorized request handling in `requests/`, and the Unix-socket transport in `socket/`. Browser-facing pages belong in `src/http/admin/pages/`; admin and subscription handlers belong in their respective HTTP areas, with shared transport helpers in `http/shared/`.
- Put sing-box process handling in `src/runtime/sing-box/` and routed probes in `runtime/health/`. Keep the Tailscale integration and healthcheck CLI at `runtime/tailscale.js` and `runtime/healthcheck.js`.
- Keep deployment-specific scripts and configuration beside their Docker or systemd assets. Both launchers must find the repository root from their own location; executable entry paths must use the nested source layout.
- Keep tests in the existing category that matches their purpose. Reuse `test/fixtures/state.js` for shared synthetic state. Name tests after the module or behavior.
- Put setup instructions in [deployment](deployment.md), ongoing administration and recovery instructions in [operations](operations.md), and contributor guidance here. Keep the [README](../README.md) focused on the gateway overview and prerequisites.

Use direct relative imports between modules and update consumers when a module moves. Do not add compatibility files at retired paths. Keep the five executable entry paths stable: `control/controller-server.js`, `http/admin-server.js`, `http/subscription-server.js`, `runtime/healthcheck.js`, and `state/bootstrap.js` under `src/`. Preserve the application-root working directory of supervised HTTP processes.

Every file under `src/` must contain at most **200 physical lines**, including blank lines and comments. Every directory under `src/`, including `src/` itself, must contain at most **8 direct entries**, counting files and subdirectories together. There are no exemptions. `npm run check:structure` runs `test/ci/check-source-structure.js`, which checks the source tree without modifying it and reports every violation; CI runs it before JavaScript syntax checks.

## Module responsibilities

Split files by policy or workflow within the structure limits. Keep a policy and its invariants together, and make new boundaries reflect the work they own. Import the module that owns a function directly; startup files only assemble and run the application.

| Area | Responsibilities and entry points |
| --- | --- |
| Domain validation and identity | `core/validation/` validates values, hosts and ingress settings. `core/identity/credentials.js` owns credential primitives; `exit-profiles.js` owns per-exit identities and credential derivation. |
| Canonical state and users | `core/model/state.js` validates private canonical state; `settings.js` and `policy.js` own shared settings and limits. `core/users/` separates user records, mutation context, lifecycle and credential rotation. |
| Server configuration | `core/server/render.js` builds sing-box configuration and routed health settings. `model.js` owns shared primitives; `assert.js` and `single-exit.js` enforce routing contracts. `single-exit-state.js` compares a single-exit configuration with canonical state. |
| Client subscriptions | `core/subscriptions/clients.js` owns client formats. `view.js` builds and validates the public projection. |
| Controller authority | `control/authority/controller.js` owns sessions, serialization and authority, delegating to the other modules in `authority/`. `runtime-transactions.js` owns runtime commit/rollback, recovery and credential retirement. |
| Control requests | `control/requests/contract.js` owns operation constraints. `dispatch.js` separates reads from mutations; `mutations.js` applies replay, CSRF and revision checks before dispatching to `users.js` or `gateway.js`. |
| Application and sockets | `control/app/application.js` assembles the application; `lifecycle.js` owns runtime readiness and shutdown. `process-settings.js` and `web-processes.js` configure and supervise HTTP children. `control/socket/` separates client calls, transport, server handling, filesystem checks and protocol constraints. |
| HTTP | `http/admin/application.js` composes request checks, authentication and routes from `request.js`, `auth.js` and `routes.js`; `pages/` owns page rendering. `http/subscription/application.js` serves projections read through `data.js`. `http/shared/` owns transport, input and limiter behavior. The two HTTP `*-server.js` files start the services. |
| Runtime and probes | `runtime/sing-box/` owns configuration checks and supervised or systemd process lifecycles. `runtime/health/readiness.js` coordinates WebSocket and authenticated SOCKS probes; the other health modules own those wire protocols. |
| Persistent state | `state/repository.js` coordinates immutable revisions. `state/filesystem/` owns file and directory validation, limits and errors; `state/revisions/` owns revision reads, writes, manifests, atomic pointers and retention. |
| Initialization | `state/bootstrap.js` is the CLI. `state/bootstrap/service.js` selects initialization or existing-state recovery; `initialize.js` and `recovery.js` own those workflows. `environment.js` reads settings, while `secrets/files.js` and `secrets/credentials.js` own secret-file reads and credential preparation. |
| Bare-metal installation | `deploy/systemd/install.sh` validates and sources a fixed ordered list of `installer/*.sh` phases. These execute in one shell so error handling, traps and transaction state retain their original scope. Keep all modules with the launcher when distributing the repository. |

Deployment scripts that invoke JavaScript functions must import their owning modules, not executable launchers. For example, import `bootstrap` from `state/bootstrap/service.js` and `readSecretFile` from `state/bootstrap/secrets/files.js`; keep command execution at `state/bootstrap.js`.

Canonical state uses schema version 3. Reject unsupported state formats without converting or overwriting them. Fresh initialization and recovery of current-format revisions are the supported startup paths.

## Commands

The npm command names remain stable:

| Command | Purpose |
| --- | --- |
| `npm test` | Run all unit, HTTP, and integration tests |
| `npm run check:structure` | Check every source file and directory against the structure limits |
| `npm start` | Start the controller server |
| `npm run bootstrap` | Initialize application state using configured settings |
| `npm run healthcheck` | Check the running gateway's health |

Application commands require the corresponding deployment configuration and state; use the [deployment guide](deployment.md) for setup.

## Tests and CI

```bash
npm run check:structure
npm test
```

GitHub CI also validates shell and Go sources, the rendered Compose security
boundary, complete Git secret history, both amd64 images, their pinned binaries,
and a real rendered sing-box configuration. It uses synthetic settings only and
never receives deployment credentials or publishes an image.

Run the full suite on supported Node 24. Linux ownership and service/deployment regressions must also pass on Linux; a passing macOS run cannot establish those guarantees.

Group tests by behavior: controller authorization, credentials, users, health and transactions; admin authentication, origin checks, mutations and rate limits; and bootstrap initialization, recovery and unsupported-state rejection. Share setup through fixtures or helpers without hiding the assertions. HTTP entry-point tests launch the real executables, check responses and verify graceful termination.

The workflow declares jobs, dependencies, permissions and pinned versions. Longer checks live in `test/ci/`: `validate-shell.sh` checks the launcher and all installer/CI modules; the Compose scripts validate declarations and rendered security boundaries; `verify-image-*.sh` and `verify-stopped-containers.sh` check image/runtime contracts; `scan-*.sh` retain the secret and vulnerability gates. `install-tool.sh` installs the workflow-pinned scanner versions. Run these scripts from the repository root unless a script documents otherwise.

The container job also runs `test/ci/verify-client-exits.js` against the pinned sing-box binary. It checks the real multi-exit server and client configurations, then uses local SOCKS witnesses to verify VLESS/WebSocket credential routing, concurrent client selections, health identities, user revocation, and no fallback when an exit fails. This test runs without external network access; it does not establish Tailscale enrollment or public Cloudflare connectivity. The script includes a local Docker invocation.

When changing deployment layout, verify a fresh installation, upgrades of supported schema-v3 deployments, and failed-upgrade restoration of the prior source tree and service units. Retired application paths must be enumerated explicitly and removed inside the existing backup and rollback transaction; preserve unrelated operator files. Check that both supervised HTTP entry files exist and retain the application-root working directory.

Keep the image-to-source comparison recursive as source directories grow. Update active path references in Compose, build contexts, workflows, and dependency-update configuration without changing historical secret-scanning exceptions. Configuration checks and synthetic tests complement the [live production verification](operations.md#verification); they do not replace it.

## Container dependency maintenance

The [gateway Dockerfile](../deploy/docker/Dockerfile) and [cloudflared Dockerfile](../deploy/docker/cloudflared.Dockerfile) rebuild the pinned application releases with security updates to their Go dependencies. Build-only manifests in [sing-box/go.mod](../deploy/docker/sing-box/go.mod) and [cloudflared/go.mod](../deploy/docker/cloudflared/go.mod), together with their adjacent `go.sum` files, lock those dependencies. Builds use the pinned Go toolchain, prevent implicit manifest updates with `-mod=readonly`, and verify module checksums.

Cloudflared's Dockerfile pins the upstream source commit and archive checksum. Refresh its manifests against that exact source checkout and preserve the upstream `replace` directives, including its QUIC fork, along with the container build settings. Keep the released application version and required sing-box build tags unless an application upgrade is intended. The gateway runtime separately pins the Node base image digest, verifies the npm archive checksum before an offline update, and applies exact OpenSSL package fixes. Keep those pins and version checks together; the Dockerfiles are the source of truth for their values.

For a dependency update:

1. Identify the affected package from the image scan, update its manifest and checksum pair or runtime pin, and retain the existing security checks and upstream replacement rules.
2. Rebuild both amd64 images using the Dockerfiles above. Run the source tests, image/runtime checks, and full Trivy image scans from the [CI workflow](../.github/workflows/ci.yml), covering operating-system and language packages with the existing severity, fix-availability, and secret-scanning settings.
3. Dispatch `CI` with `workflow_dispatch` against the working branch and verify the completed run's commit matches the proposed change. The vulnerability gate currently runs for pushes to `main`, scheduled runs, and manual dispatches; pull-request checks alone do not run that gate. Resolve every blocking finding before merging.
