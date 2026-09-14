# shellcheck shell=bash
# Validate, load, and create durable upgrade restart and rollback journals.

load_upgrade_rollback_journal() {
  local unexpected_entry completed_value quarantine_record rollback_backup
  [[ -d "$UPGRADE_ROLLBACK_JOURNAL" && ! -L "$UPGRADE_ROLLBACK_JOURNAL" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_ROLLBACK_JOURNAL")" == 0:0:700 ]] \
    || die "Upgrade rollback journal is missing or unsafe."
  unexpected_entry="$(find "$UPGRADE_ROLLBACK_JOURNAL" -mindepth 1 -maxdepth 1 \
    ! -name backup-path \
    ! -name restore-staging \
    ! -name quarantine-path \
    ! -name restored \
    ! -name completed \
    ! -name committed \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback journal contains an unexpected entry: $unexpected_entry"
  UPGRADE_BACKUP="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/backup-path" \
    '^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$' \
    'Upgrade rollback backup path')"
  ROLLBACK_RESTORE_STAGING="$STATE_ROOT/$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/restore-staging" \
    '^\.revisions-restore\.[A-Za-z0-9]{10}$' \
    'Upgrade rollback staging path')"
  ROLLBACK_QUARANTINE_PATH="$STATE_ROOT/$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/quarantine-path" \
    '^\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
    'Upgrade rollback quarantine path')"
  [[ "$ROLLBACK_RESTORE_STAGING" != "$ROLLBACK_QUARANTINE_PATH" ]] \
    || die "Upgrade rollback journal aliases staging and quarantine paths."
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/restored" '^restored$' \
      'Upgrade rollback restored-state marker')"
    [[ "$completed_value" == restored ]] \
      || die "Upgrade rollback restored-state marker is invalid."
  fi
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/completed" '^complete$' \
      'Upgrade rollback completion marker')"
    [[ "$completed_value" == complete ]] \
      || die "Upgrade rollback completion marker is invalid."
  fi
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/committed" '^commit$' \
      'Upgrade commit marker')"
    [[ "$completed_value" == commit ]] \
      || die "Upgrade commit marker is invalid."
  fi
  ! { path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed" \
      && path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; } \
    || die "Upgrade journal cannot be both committed and rolled back."
  ! { path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
      && path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; } \
    || die "Committed upgrade journal cannot contain a restored-state marker."
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
      || die "Completed rollback journal is missing its restored-state marker."
  fi
  validate_upgrade_rollback_backup
  if path_is_present "$UPGRADE_RESTART_JOURNAL"; then
    rollback_backup="$UPGRADE_BACKUP"
    load_upgrade_restart_journal
    [[ "$UPGRADE_BACKUP" == "$rollback_backup" ]] \
      || die "Upgrade restart and rollback journals reference different backups."
  fi
  quarantine_record="$UPGRADE_BACKUP/protected-state/failed-revision-namespace"
  if path_is_present "$quarantine_record"; then
    [[ "$(read_upgrade_journal_line \
      "$quarantine_record" \
      '^/var/lib/vpn-gateway/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
      'Failed revision namespace record')" == "$ROLLBACK_QUARANTINE_PATH" ]] \
      || die "Failed revision namespace record conflicts with the rollback journal."
  fi
  UPGRADE_STATE_BACKUP_READY=yes
}

write_upgrade_rollback_journal_value() {
  local journal_root="$1"
  local name="$2"
  local value="$3"
  local value_staging
  [[ "$name" =~ ^[a-z-]+$ ]] \
    || die "Upgrade rollback journal value name is invalid."
  ! path_is_present "$journal_root/$name" \
    || die "Upgrade rollback journal value already exists: $journal_root/$name"
  value_staging="$(mktemp "$STATE_ROOT/.upgrade-journal-value.XXXXXXXXXX")"
  chown root:root "$value_staging"
  chmod 0600 "$value_staging"
  printf '%s\n' "$value" >"$value_staging"
  sync -f "$value_staging"
  mv -T -- "$value_staging" "$journal_root/$name"
  sync -f "$journal_root"
  sync -f "$STATE_ROOT"
}

validate_upgrade_restart_backup() {
  [[ "$UPGRADE_BACKUP" =~ ^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade restart backup path is not canonical: $UPGRADE_BACKUP"
  [[ -d "$UPGRADE_BACKUP" && ! -L "$UPGRADE_BACKUP" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_BACKUP")" == 0:0:700 ]] \
    || die "Upgrade restart backup is missing or unsafe: $UPGRADE_BACKUP"
  load_upgrade_rollback_metadata
}

load_upgrade_restart_journal() {
  local unexpected_entry
  [[ -d "$UPGRADE_RESTART_JOURNAL" && ! -L "$UPGRADE_RESTART_JOURNAL" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_RESTART_JOURNAL")" == 0:0:700 ]] \
    || die "Upgrade restart journal is missing or unsafe."
  unexpected_entry="$(find "$UPGRADE_RESTART_JOURNAL" -mindepth 1 -maxdepth 1 \
    ! -name backup-path -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade restart journal contains an unexpected entry: $unexpected_entry"
  UPGRADE_BACKUP="$(read_upgrade_journal_line \
    "$UPGRADE_RESTART_JOURNAL/backup-path" \
    '^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$' \
    'Upgrade restart backup path')"
  validate_upgrade_restart_backup
}

prepare_upgrade_restart_journal() {
  local journal_staging
  ! path_is_present "$UPGRADE_RESTART_JOURNAL" \
    || die "An upgrade restart journal already exists. Re-run the installer to reconcile it first."
  validate_upgrade_restart_backup
  journal_staging="$(mktemp -d "$STATE_ROOT/.upgrade-restart-journal.XXXXXXXXXX")"
  chown root:root "$journal_staging"
  chmod 0700 "$journal_staging"
  write_upgrade_rollback_journal_value "$journal_staging" backup-path "$UPGRADE_BACKUP"
  sync -f "$UPGRADE_BACKUP"
  sync -f "$journal_staging"
  mv -T -- "$journal_staging" "$UPGRADE_RESTART_JOURNAL"
  sync -f "$STATE_ROOT"
  load_upgrade_restart_journal
}

retire_upgrade_restart_journal() {
  local retirement_path
  if ! path_is_present "$UPGRADE_RESTART_JOURNAL"; then
    return
  fi
  load_upgrade_restart_journal
  retirement_path="$(mktemp -d "$STATE_ROOT/.upgrade-restart-completed.XXXXXXXXXX")"
  rmdir -- "$retirement_path"
  mv -T -- "$UPGRADE_RESTART_JOURNAL" "$retirement_path"
  sync -f "$STATE_ROOT"
  [[ -d "$retirement_path" && ! -L "$retirement_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$retirement_path")" == 0:0:700 ]] \
    || die "Completed upgrade restart journal became unsafe."
  rm -rf -- "$retirement_path"
  sync -f "$STATE_ROOT"
}

prepare_upgrade_rollback_journal() {
  local restore_staging="$1"
  local quarantine_path="$2"
  local journal_staging expected_backup="$UPGRADE_BACKUP"
  ! path_is_present "$UPGRADE_ROLLBACK_JOURNAL" \
    || die "An upgrade rollback journal already exists. Re-run the installer to reconcile it first."
  path_is_present "$UPGRADE_RESTART_JOURNAL" \
    || die "Upgrade rollback cannot begin without its durable restart journal."
  load_upgrade_restart_journal
  [[ "$UPGRADE_BACKUP" == "$expected_backup" ]] \
    || die "Upgrade restart and rollback journals reference different backups."
  validate_upgrade_rollback_backup
  [[ "$restore_staging" =~ ^$STATE_ROOT/\.revisions-restore\.[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback staging path is not canonical."
  [[ "$quarantine_path" =~ ^$STATE_ROOT/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback quarantine path is not canonical."
  [[ -d "$restore_staging" && ! -L "$restore_staging" ]] \
    || die "Upgrade rollback staging directory is missing or unsafe."
  ! path_is_present "$quarantine_path" \
    || die "Upgrade rollback quarantine destination already exists."
  journal_staging="$(mktemp -d "$STATE_ROOT/.upgrade-rollback-journal.XXXXXXXXXX")"
  chown root:root "$journal_staging"
  chmod 0700 "$journal_staging"
  write_upgrade_rollback_journal_value "$journal_staging" backup-path "$UPGRADE_BACKUP"
  write_upgrade_rollback_journal_value "$journal_staging" restore-staging "${restore_staging##*/}"
  write_upgrade_rollback_journal_value "$journal_staging" quarantine-path "${quarantine_path##*/}"
  sync -f "$UPGRADE_BACKUP"
  sync -f "$restore_staging"
  sync -f "$journal_staging"
  mv -T -- "$journal_staging" "$UPGRADE_ROLLBACK_JOURNAL"
  sync -f "$STATE_ROOT"
  load_upgrade_rollback_journal
}

begin_upgrade_rollback_transaction() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  ROLLBACK_RESTORE_STAGING="$(mktemp -d "$STATE_ROOT/.revisions-restore.XXXXXXXXXX")"
  rmdir -- "$ROLLBACK_RESTORE_STAGING"
  ROLLBACK_QUARANTINE_PATH="$(mktemp -d "$STATE_ROOT/.failed-upgrade-revisions.XXXXXXXXXX")"
  rmdir -- "$ROLLBACK_QUARANTINE_PATH"
  prepare_upgrade_restore_staging
  prepare_upgrade_rollback_journal \
    "$ROLLBACK_RESTORE_STAGING" "$ROLLBACK_QUARANTINE_PATH"
}
