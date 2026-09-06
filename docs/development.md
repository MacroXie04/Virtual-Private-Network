# Development

Use Node.js `>=24.20.0 <25`, matching `package.json` and the deployment runtime. Run commands from the repository root.

## Repository layout

```text
src/
  core/         Credentials, lifecycle rules, configuration rendering, schemas, validation
  control/      Controller orchestration, control server/client, sessions
  http/         Admin page, admin/subscription servers, shared HTTP behavior
  runtime/      Process runtime, Tailscale, routed probes, healthcheck entry point
  state/        Bootstrap and persistent state repository
  migrations/   Legacy state readers and migration entry points
deploy/
  docker/       Dockerfiles, container entry point, Compose launcher, Tunnel guard
  systemd/      Bare-metal installer, sing-box wrapper, service units and target
test/
  unit/         Individual modules and behavior
  http/         HTTP routes, clients, authentication, and response behavior
  integration/  Cross-module behavior, process wiring, and deployment guarantees
  fixtures/     Shared synthetic state fixtures
  ci/           Helpers used by CI checks
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

When changing deployment layout, verify a fresh installation, an upgrade from the retired flat layout, and failed-upgrade restoration of the prior source tree and service units. The installer must remove only the enumerated retired flat source files inside its existing backup and rollback transaction. Check that both supervised HTTP entry files exist and retain the application-root working directory.

Keep the image-to-source comparison recursive as source directories grow. Update active path references in Compose, build contexts, workflows, and dependency-update configuration without changing historical secret-scanning exceptions. Configuration checks and synthetic tests complement the [live production verification](operations.md#verification); they do not replace it.
