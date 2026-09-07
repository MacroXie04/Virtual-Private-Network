#!/usr/bin/env bash
# Idempotent bare-metal deployment for Debian and Ubuntu. Dependencies must be
# installed by the operator from trusted packages before this script is run.
set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_DIR
readonly INSTALL_ROOT=/opt/vpn-gateway
readonly STATE_ROOT=/var/lib/vpn-gateway
readonly ENV_ROOT=/etc/vpn-gateway
readonly SYSTEMD_ROOT=/etc/systemd/system
readonly CONTROLLER_ENV="$ENV_ROOT/controller.env"
readonly RUNTIME_ENV="$ENV_ROOT/runtime.env"
readonly ADMIN_ENV="$ENV_ROOT/admin.env"
readonly API_ENV="$ENV_ROOT/tailscale-api.env"
readonly SECRET_ROOT="$ENV_ROOT/secrets"
readonly AUTH_KEY_PATH="$SECRET_ROOT/tailscale-auth-key"
readonly API_KEY_PATH="$SECRET_ROOT/tailscale-api-key"
readonly TUNNEL_TOKEN_PATH="$SECRET_ROOT/cloudflare-tunnel-token"
readonly LEGACY_ENV_FILE=/etc/vpn-sub.env
readonly LEGACY_CONFIG_FILE=/etc/sing-box/config.json
readonly LEGACY_STATE_DIRECTORY=/var/lib/sing-box/tailscale
readonly LEGACY_SUDOERS=/etc/sudoers.d/vpn-sub
readonly MIGRATION_MARKER="$STATE_ROOT/.legacy-migration-in-progress"
readonly MIGRATION_COMMITTED_MARKER="$STATE_ROOT/.legacy-migration-committed"
readonly UPGRADE_RESTART_JOURNAL="$STATE_ROOT/.upgrade-restart-in-progress"
readonly UPGRADE_ROLLBACK_JOURNAL="$STATE_ROOT/.upgrade-rollback-in-progress"
readonly INSTALLER_LOCK=/run/vpn-gateway-installer.lock
readonly MIN_NODE_VERSION=24.20.0
readonly REQUIRED_SINGBOX_VERSION=1.13.21
readonly REQUIRED_CLOUDFLARED_VERSION=2026.8.3
readonly MIN_SYSTEMD_VERSION=247
readonly MAX_UPGRADE_REVISIONS=32
readonly MAX_UPGRADE_REVISION_BYTES=$((64 * 1024 * 1024))

# Modules execute in this fixed order. Resolve their root from this script,
# never from a caller-provided directory or the working directory.
readonly INSTALLER_DIR="$REPO_DIR/deploy/systemd/installer"
readonly -a INSTALLER_MODULES=(
  preflight.sh
  filesystem.sh
  canonical-settings.sh
  deployment-state.sh
  legacy-inspection.sh
  service-identities.sh
  revision-namespace.sh
  upgrade-backup.sh
  upgrade-journals.sh
  restore-staging.sh
  restore-files.sh
  service-state.sh
  upgrade-recovery.sh
  recovery-preflight.sh
  upgrade-transaction.sh
  legacy-transaction.sh
  source-installation.sh
  credentials.sh
  configuration-installation.sh
  legacy-cutover.sh
  service-installation.sh
  activation.sh
)
[[ -d "$INSTALLER_DIR" && ! -L "$INSTALLER_DIR" ]] || {
  printf '%s\n' 'The installer module directory must be a real directory.' >&2
  exit 1
}
for installer_module in "${INSTALLER_MODULES[@]}"; do
  [[ -f "$INSTALLER_DIR/$installer_module" && ! -L "$INSTALLER_DIR/$installer_module" ]] || {
    printf 'Missing or unsafe installer module: %s\n' "$installer_module" >&2
    exit 1
  }
  bash -n "$INSTALLER_DIR/$installer_module"
done
unset installer_module

# shellcheck source=deploy/systemd/installer/preflight.sh
source "$INSTALLER_DIR/preflight.sh"
# shellcheck source=deploy/systemd/installer/filesystem.sh
source "$INSTALLER_DIR/filesystem.sh"
# shellcheck source=deploy/systemd/installer/canonical-settings.sh
source "$INSTALLER_DIR/canonical-settings.sh"
# shellcheck source=deploy/systemd/installer/deployment-state.sh
source "$INSTALLER_DIR/deployment-state.sh"
# shellcheck source=deploy/systemd/installer/legacy-inspection.sh
source "$INSTALLER_DIR/legacy-inspection.sh"
# shellcheck source=deploy/systemd/installer/service-identities.sh
source "$INSTALLER_DIR/service-identities.sh"
# shellcheck source=deploy/systemd/installer/revision-namespace.sh
source "$INSTALLER_DIR/revision-namespace.sh"
# shellcheck source=deploy/systemd/installer/upgrade-backup.sh
source "$INSTALLER_DIR/upgrade-backup.sh"
# shellcheck source=deploy/systemd/installer/upgrade-journals.sh
source "$INSTALLER_DIR/upgrade-journals.sh"
# shellcheck source=deploy/systemd/installer/restore-staging.sh
source "$INSTALLER_DIR/restore-staging.sh"
# shellcheck source=deploy/systemd/installer/restore-files.sh
source "$INSTALLER_DIR/restore-files.sh"
# shellcheck source=deploy/systemd/installer/service-state.sh
source "$INSTALLER_DIR/service-state.sh"
# shellcheck source=deploy/systemd/installer/upgrade-recovery.sh
source "$INSTALLER_DIR/upgrade-recovery.sh"
# shellcheck source=deploy/systemd/installer/recovery-preflight.sh
source "$INSTALLER_DIR/recovery-preflight.sh"
# shellcheck source=deploy/systemd/installer/upgrade-transaction.sh
source "$INSTALLER_DIR/upgrade-transaction.sh"
# shellcheck source=deploy/systemd/installer/legacy-transaction.sh
source "$INSTALLER_DIR/legacy-transaction.sh"
# shellcheck source=deploy/systemd/installer/source-installation.sh
source "$INSTALLER_DIR/source-installation.sh"
# shellcheck source=deploy/systemd/installer/credentials.sh
source "$INSTALLER_DIR/credentials.sh"
# shellcheck source=deploy/systemd/installer/configuration-installation.sh
source "$INSTALLER_DIR/configuration-installation.sh"
# shellcheck source=deploy/systemd/installer/legacy-cutover.sh
source "$INSTALLER_DIR/legacy-cutover.sh"
# shellcheck source=deploy/systemd/installer/service-installation.sh
source "$INSTALLER_DIR/service-installation.sh"
# shellcheck source=deploy/systemd/installer/activation.sh
source "$INSTALLER_DIR/activation.sh"
