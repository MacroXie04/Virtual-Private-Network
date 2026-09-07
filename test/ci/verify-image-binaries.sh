#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

test "$(docker run --rm --entrypoint node vpn-gateway:local --version)" = v24.20.0
test "$(docker run --rm --entrypoint npm vpn-gateway:local --version)" = 11.19.1
docker run --rm --entrypoint /usr/local/bin/sing-box \
  vpn-gateway:local version >"$RUNNER_TEMP/sing-box-version.txt"
grep -Fx 'sing-box version 1.13.21' "$RUNNER_TEMP/sing-box-version.txt"
grep -Fx 'Tags: with_gvisor,with_utls,with_tailscale' \
  "$RUNNER_TEMP/sing-box-version.txt"
docker run --rm --entrypoint /usr/local/bin/cloudflared \
  vpn-cloudflared:local --version >"$RUNNER_TEMP/cloudflared-version.txt"
grep -Eq '^cloudflared version 2026\.8\.3([[:space:]]|$)' \
  "$RUNNER_TEMP/cloudflared-version.txt"
