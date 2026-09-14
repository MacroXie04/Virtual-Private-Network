#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

for script in deploy/systemd/install.sh deploy/systemd/installer/*.sh test/ci/*.sh; do
  bash -n "$script"
done
for script in \
  deploy/docker/compose-up.sh \
  deploy/docker/entrypoint.sh \
  deploy/systemd/sing-box-wrapper.sh; do
  dash -n "$script"
done
shellcheck --external-sources --severity=warning \
  deploy/systemd/install.sh \
  deploy/docker/compose-up.sh \
  deploy/docker/entrypoint.sh \
  deploy/systemd/sing-box-wrapper.sh \
  test/ci/*.sh
