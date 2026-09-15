# shellcheck shell=bash
# Replay interrupted restart or rollback transactions and retire completed journals.

cleanup_unjournaled_upgrade_restore_artifacts() {
  local partial_path
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    \( -name '.revisions-restore.*' \
       -o -name '.revisions-restore-build.*' \
       -o -name '.revisions-restore-discard.*' \) -print0)
}

recover_interrupted_upgrade_restart() {
  [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
      && "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" != yes ]] || return 0
  echo "==> Recovering an upgrade interrupted before protected-state handoff"
  load_upgrade_restart_journal
  assert_supported_data_directory "$STATE_ROOT" \
    || die "Unsupported pre-handoff state; preserve it and use a new data directory."
  quiesce_upgrade_services_for_rollback
  cleanup_unjournaled_upgrade_restore_artifacts
  restore_upgrade_enablement
  restart_and_verify_restored_upgrade
  retire_upgrade_restart_journal
  echo "==> Pre-handoff upgrade interruption reconciled; beginning a fresh upgrade attempt"
  UPGRADE_WAS_ACTIVE=no
  UPGRADE_WAS_ENABLED=no
  UPGRADE_SINGBOX_WAS_ENABLED=no
  UPGRADE_STOPPED=no
  UPGRADE_BACKUP=""
}

archive_completed_upgrade_rollback_journal() {
  local completed_value
  load_upgrade_rollback_journal
  completed_value="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/completed" '^complete$' \
    'Upgrade rollback completion marker')"
  [[ "$completed_value" == complete ]] \
    || die "Upgrade rollback completion marker is invalid."
  validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  retire_upgrade_restart_journal
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH/.rollback-journal" \
    || die "Upgrade rollback quarantine already contains a completed journal."
  mv -T -- "$UPGRADE_ROLLBACK_JOURNAL" \
    "$ROLLBACK_QUARANTINE_PATH/.rollback-journal"
  sync -f "$ROLLBACK_QUARANTINE_PATH"
  sync -f "$STATE_ROOT"
}

mark_upgrade_rollback_restored() {
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    [[ "$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/restored" '^restored$' \
      'Upgrade rollback restored-state marker')" == restored ]] \
      || die "Upgrade rollback restored-state marker is invalid."
    return
  fi
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" restored restored
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
}

complete_upgrade_rollback_journal() {
  path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
    || die "Rollback cannot complete before restored state is durable."
  ! path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed" \
    || die "Upgrade rollback completion marker already exists unexpectedly."
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" completed complete
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
  archive_completed_upgrade_rollback_journal
}

rollback_active_upgrade_transaction() {
  load_upgrade_rollback_journal
  # Do not let a reboot start the restored predecessor until both its exact
  # protected state and its code/configuration are durable and the journal says
  # so. The predecessor may predate this installer's controller-side mutation
  # gate, so boot disablement—not old application behavior—is the invariant.
  hold_upgrade_services_disabled yes
  quiesce_upgrade_services_for_rollback
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    # The exact old namespace and deployment files were durable before this
    # marker. Do not discard revisions legitimately appended by the restored
    # controller if the machine crashed after its restart.
    restore_upgrade_deployment_files
  else
    restore_upgrade_protected_state
    restore_upgrade_deployment_files
    mark_upgrade_rollback_restored
  fi
  restore_upgrade_enablement
  restart_and_verify_restored_upgrade
  complete_upgrade_rollback_journal
}

archive_committed_upgrade_journal() {
  local committed_value retirement_path backup_token
  load_upgrade_rollback_journal
  committed_value="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/committed" '^commit$' \
    'Upgrade commit marker')"
  [[ "$committed_value" == commit ]] \
    || die "Upgrade commit marker is invalid."
  ! path_is_present "$ROLLBACK_RESTORE_STAGING" \
    || die "Committed upgrade journal still references rollback staging."
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
    || die "Committed upgrade journal unexpectedly references a quarantine namespace."
  retire_upgrade_restart_journal
  backup_token="${UPGRADE_BACKUP##*/upgrade-}"
  [[ "$backup_token" =~ ^[A-Za-z0-9]{10}$ ]] \
    || die "Committed upgrade journal has an invalid backup token."
  retirement_path="$STATE_ROOT/.upgrade-rollback-retired.$backup_token"
  ! path_is_present "$retirement_path" \
    || die "Committed upgrade journal retirement path is already occupied."
  mv -T -- "$UPGRADE_ROLLBACK_JOURNAL" "$retirement_path"
  sync -f "$STATE_ROOT"
  [[ -d "$retirement_path" && ! -L "$retirement_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$retirement_path")" == 0:0:700 ]] \
    || die "Committed upgrade journal retirement became unsafe."
  rm -rf -- "$retirement_path"
  sync -f "$STATE_ROOT"
}

commit_upgrade_rollback_transaction() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  load_upgrade_rollback_journal
  [[ -d "$ROLLBACK_RESTORE_STAGING" && ! -L "$ROLLBACK_RESTORE_STAGING" ]] \
    || die "Upgrade commit found missing or unsafe rollback staging."
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
  retire_upgrade_restore_staging
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
    || die "Upgrade commit found an unexpected rollback quarantine."
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" committed commit
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
  archive_committed_upgrade_journal
}

recover_interrupted_upgrade_rollback() {
  [[ "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]] || return 0
  echo "==> Reconciling an interrupted upgrade rollback before normal deployment"
  load_upgrade_rollback_journal
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; then
    archive_committed_upgrade_journal
  elif path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    archive_completed_upgrade_rollback_journal
  else
    rollback_active_upgrade_transaction
  fi
  echo "==> Interrupted upgrade rollback reconciled; beginning a fresh upgrade attempt"
  UPGRADE_WAS_ACTIVE=no
  UPGRADE_WAS_ENABLED=no
  UPGRADE_SINGBOX_WAS_ENABLED=no
  UPGRADE_STOPPED=no
  UPGRADE_BACKUP=""
  UPGRADE_HAD_INSTALL_ROOT=no
  UPGRADE_HAD_ENV_ROOT=no
  UPGRADE_HAD_UNIT_TARGET=no
  UPGRADE_HAD_UNIT_CONTROLLER=no
  UPGRADE_HAD_UNIT_SING_BOX=no
  UPGRADE_HAD_UNIT_SUBSCRIPTION=no
  UPGRADE_HAD_UNIT_ADMIN=no
  UPGRADE_HAD_UNIT_TUNNEL=no
  UPGRADE_STATE_BACKUP_READY=no
  ROLLBACK_RESTORE_STAGING=""
  ROLLBACK_QUARANTINE_PATH=""
}
