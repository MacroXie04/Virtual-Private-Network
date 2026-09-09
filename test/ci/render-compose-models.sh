#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

docker compose version
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml config --format json \
  >"$RUNNER_TEMP/compose.json"
TS_API_KEY_FILE=/dev/null \
  docker compose -f docker-compose.yml config --format json \
  >"$RUNNER_TEMP/compose-api-key.json"
