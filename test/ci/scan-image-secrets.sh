#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

scan_failed=0
for image in vpn-gateway:local vpn-cloudflared:local; do
  if "$RUNNER_TEMP/trivy-bin/trivy" \
    --config "$RUNNER_TEMP/trivy.yaml" \
    --cache-dir "$RUNNER_TEMP/trivy-cache" \
    --quiet \
    image \
    --disable-telemetry \
    --image-src docker \
    --scanners secret \
    --image-config-scanners secret \
    --ignorefile "$RUNNER_TEMP/trivyignore" \
    --secret-config "$RUNNER_TEMP/trivy-secret.yaml" \
    --exit-code 1 \
    --format json \
    --output /dev/null \
    --list-all-pkgs=false \
    --no-progress \
    --skip-version-check \
    --timeout 10m \
    "$image"; then
    continue
  else
    echo "Trivy failed or detected a potential secret in $image; details are suppressed." >&2
    scan_failed=1
  fi
done
test "$scan_failed" -eq 0
