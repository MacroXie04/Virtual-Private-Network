# Development

Use Node.js `>=24.20.0 <25`, matching `package.json` and the deployment runtime. Run commands from the repository root.

## Repository layout

```text
src/
  core/         Domain rules, server configuration, client subscriptions, public projection
  control/      Application lifecycle, serialized authority, sockets, sessions
    operations/ User and gateway mutations behind the shared authorization boundary
  http/         HTTP applications, authentication, routes, request and response helpers
  runtime/      Process runtime, Tailscale, routed probes, healthcheck entry point
  state/        Bootstrap and persistent state repository
  migrations/   Legacy state readers and migration entry points
deploy/
  docker/       Dockerfiles, container entry point, Compose launcher, Tunnel guard
  systemd/      Installer entry point, sing-box wrapper, service units and target
    installer/  Ordered installation, migration, backup, rollback and service phases
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

- Put domain rules that do not own persistence or network servers in `src/core/`. Put persistent state access and first-run initialization in `src/state/`.
- Put control orchestration and its protocol in `src/control/`; browser-facing pages, HTTP endpoints, and HTTP helpers belong in `src/http/`.
- Put operating-system process handling, Tailscale integration, probes, and executable health checks in `src/runtime/`. Keep legacy format handling in `src/migrations/`.
- Keep deployment-specific scripts and configuration beside their Docker or systemd assets. Both launchers must find the repository root from their own location; executable entry paths must use the nested source layout.
- Keep tests in the existing category that matches their purpose. Reuse `test/fixtures/state.js` for shared synthetic state. Name current-behavior tests after the module or behavior, without a `core-` prefix or `-v2` suffix; retain explicit version names for historical migration tests such as `migration-v1.test.js`.
- Put setup instructions in [deployment](deployment.md), ongoing administration and recovery instructions in [operations](operations.md), and contributor guidance here. Keep the [README](../README.md) focused on the gateway overview and prerequisites.

Use direct relative imports between modules and update consumers when a module moves. Do not add compatibility files at retired paths. When moving an executable, update npm scripts, deployment launchers, service units, child-process resolution, and tests together. Preserve the application-root working directory of supervised HTTP processes.

## Module responsibilities

Split files when they own separate policies or workflows, rather than dividing at an arbitrary line count. Keep a policy and its invariants together. Import the module that owns a function directly; startup files only assemble and run the application.

| Area | Responsibilities and entry points |
| --- | --- |
| Server configuration | `core/server-render.js` builds sing-box configuration and routed health settings. `server-config-model.js` owns shared configuration primitives; `server-config-assert.js` and `single-exit-config-assert.js` enforce their exact routing contracts. |
| Client subscriptions | `core/client-subscriptions.js` owns client formats. `subscription-view.js` builds and validates the public projection; `state-schema.js` validates private canonical state. `exit-profiles.js` owns per-exit identities and credentials. |
| Controller | `control/controller.js` owns sessions, serialization and authority. `request-dispatch.js` separates read operations from mutations; `operations/mutations.js` applies replay, CSRF and revision checks before dispatching to `users.js` or `gateway.js`. `runtime-transactions.js` owns runtime commit/rollback and credential retirement; `ingress-recovery.js` owns legacy ingress recovery. |
| Application and sockets | `control/application.js` coordinates startup, readiness and shutdown. `web-processes.js` owns supervised HTTP children. `control-socket.js`, `socket-protocol.js` and `socket-files.js` separate socket serving, message constraints and filesystem checks. `controller-server.js` remains the executable used by npm and deployment. |
| HTTP | `http/admin-application.js` composes request checks, authentication and routes from `admin-request.js`, `admin-auth.js` and `admin-routes.js`. `subscription-application.js` serves projections read through `subscription-data.js`. The two `*-server.js` files only start the services; `http-service.js`, `request-input.js` and `rate-limit.js` own shared transport, input and limiter behavior. |
| Persistent state | `state/repository.js` coordinates immutable revisions. `repository-files.js`, `repository-pointers.js`, `revision-directory.js`, `revision-content.js`, `revision-manifest.js` and `revision-retention.js` own their respective validation and filesystem operations. Shared limits and errors live in `repository-policy.js`. |
| Initialization | `state/bootstrap.js` is the CLI. `bootstrap-service.js` selects initialization, existing-state recovery or ingress migration; the corresponding bootstrap modules own those workflows. Secret-file reads, credential preparation and candidate validation each have separate modules. |
| Legacy migration | `migrations/migrate-v1.js` coordinates migration. `legacy-v1-parse.js`, `legacy-v1-source.js` and `legacy-v1-state.js` interpret the old format. The migration marker, backup, recovery and lineage modules preserve transaction evidence. `legacy-v2-state.js` and `legacy-v2-policy.js` validate historical state and configuration. |
| Bare-metal installation | `deploy/systemd/install.sh` validates and sources a fixed ordered list of `installer/*.sh` phases. These execute in one shell so error handling, traps and transaction state retain their original scope. Keep all modules with the launcher when distributing the repository. |

Deployment scripts that invoke JavaScript functions must import their owning modules, not executable launchers. For example, import `bootstrap` from `state/bootstrap-service.js`, `readSecretFile` from `state/bootstrap-files.js`, and `inspectLegacyV1` from `migrations/legacy-v1-source.js`; keep command execution at `state/bootstrap.js`.

## Commands

The npm command names remain stable:

| Command | Purpose |
| --- | --- |
| `npm test` | Run all unit, HTTP, and integration tests |
| `npm start` | Start the controller server |
| `npm run bootstrap` | Initialize application state using configured settings |
| `npm run healthcheck` | Check the running gateway's health |

Application commands require the corresponding deployment configuration and state; use the [deployment guide](deployment.md) for setup.

## Tests and CI

```bash
npm test
```

GitHub CI also validates shell and Go sources, the rendered Compose security
boundary, complete Git secret history, both amd64 images, their pinned binaries,
and a real rendered sing-box configuration. It uses synthetic settings only and
never receives deployment credentials or publishes an image.

Run the full suite on supported Node 24. Linux ownership and service/deployment regressions must also pass on Linux; a passing macOS run cannot establish those guarantees.

Group tests by behavior: controller authorization, credentials, users, health and transactions; admin authentication, origin checks, mutations and rate limits; bootstrap initialization, recovery and ingress migration; and migration parsing, recovery and lineage. Share setup through fixtures or helpers without hiding the assertions. HTTP entry-point tests launch the real executables, check responses and verify graceful termination.

The workflow declares jobs, dependencies, permissions and pinned versions. Longer checks live in `test/ci/`: `validate-shell.sh` checks the launcher and all installer/CI modules; the Compose scripts validate declarations and rendered security boundaries; `verify-image-*.sh` and `verify-stopped-containers.sh` check image/runtime contracts; `scan-*.sh` retain the secret and vulnerability gates. `install-tool.sh` installs the workflow-pinned scanner versions. Run these scripts from the repository root unless a script documents otherwise.

The container job also runs `test/ci/verify-client-exits.js` against the pinned sing-box binary. It checks the real multi-exit server and client configurations, then uses local SOCKS witnesses to verify VLESS/WebSocket credential routing, concurrent client selections, health identities, user revocation, and no fallback when an exit fails. This test runs without external network access; it does not establish Tailscale enrollment or public Cloudflare connectivity. The script includes a local Docker invocation.

When changing deployment layout, verify a fresh installation, upgrades from both the retired flat layout and the previous nested layout, and failed-upgrade restoration of the prior source tree and service units. Retired application paths must be enumerated explicitly and removed inside the existing backup and rollback transaction; preserve unrelated operator files. Check that both supervised HTTP entry files exist and retain the application-root working directory.

Keep the image-to-source comparison recursive as source directories grow. Update active path references in Compose, build contexts, workflows, and dependency-update configuration without changing historical secret-scanning exceptions. Configuration checks and synthetic tests complement the [live production verification](operations.md#verification); they do not replace it.

## Container dependency maintenance

The [gateway Dockerfile](../deploy/docker/Dockerfile) and [cloudflared Dockerfile](../deploy/docker/cloudflared.Dockerfile) rebuild the pinned application releases with security updates to their Go dependencies. Build-only manifests in [sing-box/go.mod](../deploy/docker/sing-box/go.mod) and [cloudflared/go.mod](../deploy/docker/cloudflared/go.mod), together with their adjacent `go.sum` files, lock those dependencies. Builds use the pinned Go toolchain, prevent implicit manifest updates with `-mod=readonly`, and verify module checksums.

Cloudflared's Dockerfile pins the upstream source commit and archive checksum. Refresh its manifests against that exact source checkout and preserve the upstream `replace` directives, including its QUIC fork, along with the container build settings. Keep the released application version and required sing-box build tags unless an application upgrade is intended. The gateway runtime separately pins the Node base image digest, verifies the npm archive checksum before an offline update, and applies exact OpenSSL package fixes. Keep those pins and version checks together; the Dockerfiles are the source of truth for their values.

For a dependency update:

1. Identify the affected package from the image scan, update its manifest and checksum pair or runtime pin, and retain the existing security checks and upstream replacement rules.
2. Rebuild both amd64 images using the Dockerfiles above. Run the source tests, image/runtime checks, and full Trivy image scans from the [CI workflow](../.github/workflows/ci.yml), covering operating-system and language packages with the existing severity, fix-availability, and secret-scanning settings.
3. Dispatch `CI` with `workflow_dispatch` against the working branch and verify the completed run's commit matches the proposed change. The vulnerability gate currently runs for pushes to `main`, scheduled runs, and manual dispatches; pull-request checks alone do not run that gate. Resolve every blocking finding before merging.
