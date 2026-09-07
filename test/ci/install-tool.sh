#!/usr/bin/env bash
set -euo pipefail

# Run against the repository containing this script, independent of caller cwd.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

case "${1:-}" in
  shellcheck)
    archive="$RUNNER_TEMP/shellcheck-v0.11.0.linux.x86_64.tar.xz"
    bin_dir="$RUNNER_TEMP/bin"
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors \
      --output "$archive" \
      https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz
    printf '%s  %s\n' "$SHELLCHECK_ARCHIVE_SHA256" "$archive" \
      | sha256sum --check --strict
    tar -xJf "$archive" -C "$RUNNER_TEMP"
    install -d -m 0755 "$bin_dir"
    install -m 0755 \
      "$RUNNER_TEMP/shellcheck-v0.11.0/shellcheck" \
      "$bin_dir/shellcheck"
    echo "$bin_dir" >>"$GITHUB_PATH"
    ;;
  gitleaks)
    archive="$RUNNER_TEMP/gitleaks_8.30.1_linux_x64.tar.gz"
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors \
      --output "$archive" \
      https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
    printf '%s  %s\n' "$GITLEAKS_ARCHIVE_SHA256" "$archive" \
      | sha256sum --check --strict
    tar -xzf "$archive" -C "$RUNNER_TEMP" gitleaks
    chmod 0755 "$RUNNER_TEMP/gitleaks"
    printf '[extend]\nuseDefault = true\n' >"$RUNNER_TEMP/gitleaks.toml"
    printf '%s\n' \
      '32a17ce52d93d47559ef0103336e2a44c0795c93:test/unit/core-v2-fixture.js:generic-api-key:32' \
      '32a17ce52d93d47559ef0103336e2a44c0795c93:test/unit/core-validation-v2.test.js:generic-api-key:141' \
      '32a17ce52d93d47559ef0103336e2a44c0795c93:test/unit/migration-v1-v2.test.js:generic-api-key:25' \
      '32a17ce52d93d47559ef0103336e2a44c0795c93:test/integration/controller.test.js:generic-api-key:61' \
      >"$RUNNER_TEMP/gitleaksignore"
    ;;
  trivy)
    archive="$RUNNER_TEMP/trivy_0.74.0_Linux-64bit.tar.gz"
    bin_dir="$RUNNER_TEMP/trivy-bin"
    curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors \
      --output "$archive" \
      https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-64bit.tar.gz
    printf '%s  %s\n' "$TRIVY_ARCHIVE_SHA256" "$archive" \
      | sha256sum --check --strict
    mkdir -p "$bin_dir"
    tar -xzf "$archive" -C "$bin_dir" trivy
    chmod 0755 "$bin_dir/trivy"
    test "$("$bin_dir/trivy" --version)" = 'Version: 0.74.0'
    printf '{}\n' >"$RUNNER_TEMP/trivy.yaml"
    : >"$RUNNER_TEMP/trivyignore"
    test ! -e "$RUNNER_TEMP/trivy-secret.yaml"
    ;;
  *)
    printf '%s\n' 'Usage: install-tool.sh shellcheck|gitleaks|trivy' >&2
    exit 2
    ;;
esac
