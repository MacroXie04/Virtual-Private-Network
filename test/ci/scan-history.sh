#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

"$RUNNER_TEMP/gitleaks" git \
  --config "$RUNNER_TEMP/gitleaks.toml" \
  --gitleaks-ignore-path "$RUNNER_TEMP/gitleaksignore" \
  --ignore-gitleaks-allow \
  --max-archive-depth=1 \
  --redact=100 \
  --no-banner \
  --no-color \
  --timeout=120 \
  .
