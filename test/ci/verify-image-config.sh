#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

node test/ci/write-valid-state.js "$RUNNER_TEMP/state.json"
docker run --rm \
  --entrypoint node \
  --volume "$RUNNER_TEMP/state.json:/tmp/state.json:ro" \
  vpn-gateway:local \
  --input-type=module \
  --eval '
    import { readFile } from "node:fs/promises";
    import { renderSingBoxConfig } from "/app/src/core/server/render.js";
    const state = JSON.parse(await readFile("/tmp/state.json", "utf8"));
    process.stdout.write(`${JSON.stringify(renderSingBoxConfig(state), null, 2)}\n`);
  ' >"$RUNNER_TEMP/sing-box.json"
docker run --rm \
  --entrypoint /usr/local/bin/sing-box \
  --volume "$RUNNER_TEMP/sing-box.json:/tmp/sing-box.json:ro" \
  vpn-gateway:local \
  check -c /tmp/sing-box.json
