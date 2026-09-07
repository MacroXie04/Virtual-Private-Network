# shellcheck shell=bash
# Restore protected state, atomic pointers, and the prior deployment files.

restore_upgrade_revision_namespace() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  path_is_present "$UPGRADE_ROLLBACK_JOURNAL" \
    || die "Protected-state rollback requires its durable rollback journal."
  load_upgrade_rollback_journal
  reconcile_upgrade_revision_namespace
}

restore_upgrade_pointer() {
  local pointer_name="$1"
  local pointer_path="$STATE_ROOT/$pointer_name"
  local target_file="$UPGRADE_BACKUP/protected-state/$pointer_name.target"
  local absent_file="$UPGRADE_BACKUP/protected-state/$pointer_name.absent"
  local pointer_target restore_staging
  if [[ -f "$target_file" && ! -L "$target_file" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$target_file")" == 0:600:1 ]]; then
    pointer_target="$(<"$target_file")"
    [[ "$pointer_target" =~ ^revisions/[0-9]{16}-[0-9a-f]{16}$ ]] \
      || die "Upgrade pointer journal is invalid: $target_file"
    validate_upgrade_revision "$STATE_ROOT/$pointer_target"
    grep -Fxq -- "${pointer_target#revisions/}" \
      "$UPGRADE_BACKUP/protected-state/revision-set" \
      || die "Upgrade pointer target is absent from the restored revision set: $pointer_target"
    if path_is_present "$pointer_path"; then
      [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
        || die "Refusing to replace unsafe pointer during rollback: $pointer_path"
    fi
    restore_staging="$(mktemp -d "$STATE_ROOT/.pointer-restore.XXXXXXXXXX")"
    chmod 0700 "$restore_staging"
    ln -s -- "$pointer_target" "$restore_staging/$pointer_name"
    mv -T -- "$restore_staging/$pointer_name" "$pointer_path"
    rmdir -- "$restore_staging"
    sync -f "$STATE_ROOT"
  elif [[ -f "$absent_file" && ! -L "$absent_file" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$absent_file")" == 0:600:1 ]]; then
    if path_is_present "$pointer_path"; then
      [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
        || die "Refusing to remove unsafe pointer during rollback: $pointer_path"
      rm -f -- "$pointer_path"
      sync -f "$STATE_ROOT"
    fi
  else
    die "Upgrade pointer journal is missing or unsafe for $pointer_name."
  fi
}

restore_upgrade_protected_state() {
  local maintenance_path="$STATE_ROOT/maintenance"
  local maintenance_staging
  [[ "$UPGRADE_STATE_BACKUP_READY" == yes ]] || return 0
  restore_upgrade_revision_namespace
  restore_upgrade_pointer current
  restore_upgrade_pointer runtime
  if [[ -f "$UPGRADE_BACKUP/protected-state/maintenance.present" ]] \
      && [[ ! -L "$UPGRADE_BACKUP/protected-state/maintenance.present" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$UPGRADE_BACKUP/protected-state/maintenance.present")" == 0:0:600:1 ]]; then
    if path_is_present "$maintenance_path"; then
      [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
        && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
        || die "Refusing to replace an unsafe maintenance marker during rollback."
    fi
    maintenance_staging="$(mktemp "$STATE_ROOT/.maintenance-restore.XXXXXXXXXX")"
    install -o root -g root -m 0600 \
      "$UPGRADE_BACKUP/protected-state/maintenance.present" "$maintenance_staging"
    mv -T -- "$maintenance_staging" "$maintenance_path"
    sync -f "$STATE_ROOT"
  elif [[ -f "$UPGRADE_BACKUP/protected-state/maintenance.absent" ]] \
      && [[ ! -L "$UPGRADE_BACKUP/protected-state/maintenance.absent" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$UPGRADE_BACKUP/protected-state/maintenance.absent")" == 0:600:1 ]]; then
    if path_is_present "$maintenance_path"; then
      [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
        && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
        || die "Refusing to remove an unsafe maintenance marker during rollback."
      rm -f -- "$maintenance_path"
      sync -f "$STATE_ROOT"
    fi
  else
    die "Upgrade maintenance journal is missing or unsafe."
  fi
}

restore_upgrade_deployment_files() {
  local unit_file
  validate_upgrade_rollback_backup
  validate_fixed_directory "$INSTALL_ROOT"
  validate_fixed_directory "$ENV_ROOT"
  for unit_file in "${UNIT_FILES[@]}"; do
    validate_fixed_file "$SYSTEMD_ROOT/$unit_file"
  done
  rm -rf -- "$INSTALL_ROOT"
  if [[ "$UPGRADE_HAD_INSTALL_ROOT" == yes ]]; then
    cp -a -- "$UPGRADE_BACKUP/install-root" "$INSTALL_ROOT"
  fi
  rm -rf -- "$ENV_ROOT"
  if [[ "$UPGRADE_HAD_ENV_ROOT" == yes ]]; then
    cp -a -- "$UPGRADE_BACKUP/environment-root" "$ENV_ROOT"
  fi
  for unit_file in "${UNIT_FILES[@]}"; do
    rm -f -- "$SYSTEMD_ROOT/$unit_file"
    if [[ -f "$UPGRADE_BACKUP/units/$unit_file" ]]; then
      cp -a -- "$UPGRADE_BACKUP/units/$unit_file" "$SYSTEMD_ROOT/$unit_file"
    fi
  done
  sync -f /opt
  sync -f /etc
  systemctl daemon-reload
}
