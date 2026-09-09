# shellcheck shell=bash
# Install the failure trap and back up an existing deployment before mutation.

restore_previous_deployment_on_failure() {
  local status=$?
  trap - EXIT
  if [[ -n "$SECRET_STAGING" ]]; then
    case "$SECRET_STAGING" in
      "$SECRET_ROOT"/.secret.??????)
        if [[ -f "$SECRET_STAGING" && ! -L "$SECRET_STAGING" ]] \
            && [[ "$(stat -c '%u:%a:%h' -- "$SECRET_STAGING")" == 0:600:1 ]]; then
          rm -f -- "$SECRET_STAGING"
        fi
        ;;
    esac
  fi

  if [[ $status -ne 0 && "$UPGRADE_STOPPED" == yes && "$DEPLOYMENT_HANDOFF_COMPLETE" != yes ]]; then
    echo "==> Upgrade did not become ready; restoring the previous deployment from $UPGRADE_BACKUP" >&2
    if path_is_present "$UPGRADE_ROLLBACK_JOURNAL"; then
      rollback_active_upgrade_transaction
    elif path_is_present "$UPGRADE_RESTART_JOURNAL"; then
      load_upgrade_restart_journal
      quiesce_upgrade_services_for_rollback
      cleanup_unjournaled_upgrade_restore_artifacts
      restore_upgrade_enablement
      restart_and_verify_restored_upgrade
      retire_upgrade_restart_journal
    else
      die "Upgrade failed after shutdown without a durable recovery journal."
    fi
  fi
  exit "$status"
}
trap restore_previous_deployment_on_failure EXIT

if [[ "$INSTALL_MODE" == existing ]]; then
  target_enablement_state="$(query_upgrade_enablement vpn-gateway.target no)"
  singbox_enablement_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
  existing_service_names=(
    vpn-gateway.target \
    vpn-gateway-controller.service \
    vpn-gateway-sing-box.service \
    vpn-gateway-subscription.service \
    vpn-gateway-admin.service
  )
  for service_name in "${existing_service_names[@]}"; do
    service_active_state="$(query_unit_active_state "$service_name")"
    if [[ "$service_active_state" == active ]]; then
      UPGRADE_WAS_ACTIVE=yes
    fi
  done
  tunnel_active_state="$(query_unit_active_state vpn-gateway-tunnel.service yes)"
  if [[ "$tunnel_active_state" == active ]]; then
    UPGRADE_WAS_ACTIVE=yes
  fi
  if [[ "$target_enablement_state" == enabled ]]; then
    UPGRADE_WAS_ENABLED=yes
  fi
  if [[ "$singbox_enablement_state" == enabled ]]; then
    UPGRADE_SINGBOX_WAS_ENABLED=yes
  fi

  install -d -o root -g root -m 0700 /var/backups/vpn-gateway
  UPGRADE_BACKUP="$(mktemp -d /var/backups/vpn-gateway/upgrade-XXXXXXXXXX)"
  chmod 0700 "$UPGRADE_BACKUP"
  install -d -o root -g root -m 0700 \
    "$UPGRADE_BACKUP/units" "$UPGRADE_BACKUP/rollback-metadata"
  if path_is_present "$INSTALL_ROOT"; then
    [[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] \
      || die "$INSTALL_ROOT must be a directory, not a symlink."
    cp -a -- "$INSTALL_ROOT" "$UPGRADE_BACKUP/install-root"
    UPGRADE_HAD_INSTALL_ROOT=yes
  fi
  if path_is_present "$ENV_ROOT"; then
    [[ -d "$ENV_ROOT" && ! -L "$ENV_ROOT" ]] \
      || die "$ENV_ROOT must be a directory, not a symlink."
    cp -a -- "$ENV_ROOT" "$UPGRADE_BACKUP/environment-root"
    UPGRADE_HAD_ENV_ROOT=yes
  fi
  for unit_file in "${UNIT_FILES[@]}"; do
    if path_is_present "$SYSTEMD_ROOT/$unit_file"; then
      [[ -f "$SYSTEMD_ROOT/$unit_file" && ! -L "$SYSTEMD_ROOT/$unit_file" ]] \
        || die "$SYSTEMD_ROOT/$unit_file must be a regular file, not a symlink."
      cp -a -- "$SYSTEMD_ROOT/$unit_file" "$UPGRADE_BACKUP/units/$unit_file"
      case "$unit_file" in
        vpn-gateway.target) UPGRADE_HAD_UNIT_TARGET=yes ;;
        vpn-gateway-controller.service) UPGRADE_HAD_UNIT_CONTROLLER=yes ;;
        vpn-gateway-sing-box.service) UPGRADE_HAD_UNIT_SING_BOX=yes ;;
        vpn-gateway-subscription.service) UPGRADE_HAD_UNIT_SUBSCRIPTION=yes ;;
        vpn-gateway-admin.service) UPGRADE_HAD_UNIT_ADMIN=yes ;;
        vpn-gateway-tunnel.service) UPGRADE_HAD_UNIT_TUNNEL=yes ;;
      esac
    fi
  done
  persist_upgrade_rollback_metadata

  echo "==> Publishing restart intent before disabling or stopping the current deployment"
  prepare_upgrade_restart_journal
  UPGRADE_STOPPED=yes
  hold_upgrade_services_disabled
  echo "==> Stopping the current deployment after saving rollback files in $UPGRADE_BACKUP"
  quiesce_upgrade_services_for_rollback
  normalize_upgrade_repository_ownership
  reconcile_repository_revision_crash_artifacts "$STATE_ROOT/revisions"
  echo "==> Saving the stopped deployment's protected revisions and atomic pointers"
  backup_upgrade_protected_state
  echo "==> Persisting the crash-recovery journal before deployment mutation"
  begin_upgrade_rollback_transaction
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/src" "$INSTALL_ROOT/bin"
install -d -o root -g root -m 0751 "$STATE_ROOT" "$STATE_ROOT/revisions"
install -d -o vpn-runtime -g vpn-runtime -m 0700 "$STATE_ROOT/tailscale"
install -d -o root -g root -m 0700 "$ENV_ROOT"
install -d -o root -g root -m 0700 "$SECRET_ROOT"
cleanup_orphaned_secret_staging
