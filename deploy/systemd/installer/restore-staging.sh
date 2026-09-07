# shellcheck shell=bash
# Validate quarantine and stage or reconcile interrupted namespace restoration.

validate_and_seal_upgrade_quarantine() {
  local quarantine_path="$1"
  local quarantine_mode
  [[ -d "$quarantine_path" && ! -L "$quarantine_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$quarantine_path")" == 0:0 ]] \
    || die "Upgrade rollback quarantine is missing or unsafe: $quarantine_path"
  reconcile_repository_revision_crash_artifacts "$quarantine_path"
  quarantine_mode="$(stat -c '%a' -- "$quarantine_path")"
  case "$quarantine_mode" in
    700)
      validate_upgrade_revision_namespace "$quarantine_path" "" 700
      ;;
    751)
      validate_upgrade_revision_namespace "$quarantine_path" "" 751
      chmod 0700 "$quarantine_path"
      sync -f "$quarantine_path"
      ;;
    *)
      die "Upgrade rollback quarantine has unsafe permissions: $quarantine_path"
      ;;
  esac
}

record_failed_upgrade_namespace() {
  local quarantine_path="$1"
  local quarantine_record="$UPGRADE_BACKUP/protected-state/failed-revision-namespace"
  local record_staging existing_value staged_value staging_count=0
  if path_is_present "$quarantine_record"; then
    existing_value="$(read_upgrade_journal_line \
      "$quarantine_record" \
      '^/var/lib/vpn-gateway/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
      'Failed revision namespace record')"
    [[ "$existing_value" == "$quarantine_path" ]] \
      || die "Failed revision namespace record conflicts with the rollback transaction."
    return
  fi
  while IFS= read -r -d '' record_staging; do
    ((staging_count += 1))
    staged_value="$(<"$record_staging")"
    if [[ "$staged_value" != "$quarantine_path" ]] \
        || (( $(stat -c '%s' -- "$record_staging") != ${#staged_value} + 1 )); then
      rm -f -- "$record_staging"
      record_staging=""
      staging_count=0
    fi
  done < <(find "$UPGRADE_BACKUP/protected-state" -mindepth 1 -maxdepth 1 \
    -name '.failed-revision-namespace.*' -print0)
  (( staging_count <= 1 )) \
    || die "Multiple failed revision namespace staging records exist."
  if (( staging_count == 0 )); then
    record_staging="$(mktemp "$UPGRADE_BACKUP/protected-state/.failed-revision-namespace.XXXXXXXXXX")"
    chown root:root "$record_staging"
    chmod 0600 "$record_staging"
    printf '%s\n' "$quarantine_path" >"$record_staging"
    sync -f "$record_staging"
  fi
  mv -T -- "$record_staging" "$quarantine_record"
  sync -f "$UPGRADE_BACKUP/protected-state"
}

validate_partial_upgrade_restore_tree() {
  local partial_path="$1"
  local partial_name="${partial_path##*/}"
  local revision_path revision_id file_path file_name stat_record owner_id group_id permission_mode link_count file_size max_bytes
  local revision_count=0
  local total_bytes=0
  [[ "$partial_name" =~ ^\.revisions-restore-build\.[A-Za-z0-9]{10}\.[A-Za-z0-9]{10}$ \
      || "$partial_name" =~ ^\.revisions-restore-discard\.[A-Za-z0-9]{10}$ \
      || "$partial_name" =~ ^\.revisions-restore\.[A-Za-z0-9]{10}$ ]] \
    || die "Partial rollback staging path is not canonical: $partial_path"
  [[ -d "$partial_path" && ! -L "$partial_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$partial_path")" == 0:0 ]] \
    || die "Partial rollback staging directory is unsafe: $partial_path"
  permission_mode="$(stat -c '%a' -- "$partial_path")"
  [[ "$permission_mode" == 700 || "$permission_mode" == 751 ]] \
    || die "Partial rollback staging directory has unsafe permissions: $partial_path"
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
      || die "Partial rollback staging contains an unexpected entry: $revision_path"
    [[ -d "$revision_path" && ! -L "$revision_path" ]] \
      && [[ "$(stat -c '%u:%g' -- "$revision_path")" == 0:0 ]] \
      || die "Partial rollback revision directory is unsafe: $revision_path"
    permission_mode="$(stat -c '%a' -- "$revision_path")"
    [[ "$permission_mode" == 700 || "$permission_mode" == 751 ]] \
      || die "Partial rollback revision directory has unsafe permissions: $revision_path"
    while IFS= read -r -d '' file_path; do
      file_name="${file_path##*/}"
      [[ -f "$file_path" && ! -L "$file_path" ]] \
        || die "Partial rollback revision contains an unsafe entry: $file_path"
      stat_record="$(stat -c '%u:%g:%a:%h' -- "$file_path")"
      IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
      [[ "$owner_id" == 0 && "$link_count" == 1 ]] \
        || die "Partial rollback revision file has unsafe ownership or links: $file_path"
      case "$file_name" in
        manifest.json)
          [[ "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback manifest has unsafe permissions."
          max_bytes=$((64 * 1024))
          ;;
        state.json)
          [[ "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback state has unsafe permissions."
          max_bytes=$((1024 * 1024))
          ;;
        sing-box.json)
          [[ "$group_id:$permission_mode" == "$RUNTIME_GID:640" \
              || "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback runtime projection has unsafe permissions."
          max_bytes=$((4 * 1024 * 1024))
          ;;
        subscription-view.json)
          [[ "$group_id:$permission_mode" == "$SUB_GID_VALUE:640" \
              || "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback subscription projection has unsafe permissions."
          max_bytes=$((1024 * 1024))
          ;;
        *) die "Partial rollback revision contains an unexpected entry: $file_path" ;;
      esac
      file_size="$(stat -c '%s' -- "$file_path")"
      if [[ ! "$file_size" =~ ^[0-9]+$ ]] || (( file_size > max_bytes )); then
        die "Partial rollback revision file exceeds its storage bound: $file_path"
      fi
      total_bytes=$((total_bytes + file_size))
    done < <(find "$revision_path" -mindepth 1 -maxdepth 1 -print0)
    (( revision_count += 1 ))
    (( revision_count <= MAX_UPGRADE_REVISIONS \
        && total_bytes <= MAX_UPGRADE_REVISION_BYTES )) \
      || die "Partial rollback staging exceeds the supported snapshot budget."
  done < <(find "$partial_path" -mindepth 1 -maxdepth 1 -print0)
}

remove_partial_upgrade_restore_tree() {
  local partial_path="$1"
  validate_partial_upgrade_restore_tree "$partial_path"
  chmod 0700 "$partial_path"
  rm -rf -- "$partial_path"
  sync -f "$STATE_ROOT"
}

partial_upgrade_restore_matches_snapshot() {
  local partial_path="$1"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local revision_id file_name actual_count=0 expected_count=0
  local -a partial_entries=()
  validate_partial_upgrade_restore_tree "$partial_path"
  mapfile -d '' -t partial_entries \
    < <(find "$partial_path" -mindepth 1 -maxdepth 1 -print0)
  actual_count="${#partial_entries[@]}"
  while IFS= read -r revision_id; do
    ((expected_count += 1))
    [[ -d "$partial_path/$revision_id" && ! -L "$partial_path/$revision_id" ]] \
      || return 1
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      [[ -f "$partial_path/$revision_id/$file_name" \
          && ! -L "$partial_path/$revision_id/$file_name" ]] \
        || return 1
      cmp -s -- \
        "$backup_namespace/$revision_id/$file_name" \
        "$partial_path/$revision_id/$file_name" \
        || return 1
    done
  done <"$revision_set"
  [[ "$actual_count" == "$expected_count" ]]
}

retire_partial_upgrade_restore_tree() {
  local partial_path="$1"
  local discard_path
  validate_partial_upgrade_restore_tree "$partial_path"
  discard_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-discard.XXXXXXXXXX")"
  rmdir -- "$discard_path"
  mv -T -- "$partial_path" "$discard_path"
  sync -f "$STATE_ROOT"
  remove_partial_upgrade_restore_tree "$discard_path"
}

reconcile_partial_upgrade_restore_builds() {
  local restore_token="${ROLLBACK_RESTORE_STAGING##*.}"
  local partial_path
  [[ "$restore_token" =~ ^[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback staging token is invalid."
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    -name ".revisions-restore-build.$restore_token.*" -print0)
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    -name '.revisions-restore-discard.*' -print0)
}

prepare_upgrade_restore_staging() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local restore_token="${ROLLBACK_RESTORE_STAGING##*.}"
  local build_path
  if path_is_present "$ROLLBACK_RESTORE_STAGING"; then
    if partial_upgrade_restore_matches_snapshot "$ROLLBACK_RESTORE_STAGING"; then
      chmod 0751 "$ROLLBACK_RESTORE_STAGING"
      compare_upgrade_revision_namespaces \
        "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
      return
    fi
    retire_partial_upgrade_restore_tree "$ROLLBACK_RESTORE_STAGING"
  fi
  reconcile_partial_upgrade_restore_builds
  build_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-build.$restore_token.XXXXXXXXXX")"
  chown root:root "$build_path"
  chmod 0700 "$build_path"
  cp -a -- "$backup_namespace/." "$build_path/"
  chmod 0751 "$build_path"
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$build_path" "$revision_set"
  sync -f "$build_path"
  ! path_is_present "$ROLLBACK_RESTORE_STAGING" \
    || die "Upgrade rollback staging appeared while its atomic replacement was built."
  mv -T -- "$build_path" "$ROLLBACK_RESTORE_STAGING"
  sync -f "$STATE_ROOT"
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
}

retire_upgrade_restore_staging() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local discard_path
  [[ -d "$ROLLBACK_RESTORE_STAGING" && ! -L "$ROLLBACK_RESTORE_STAGING" ]] \
    || die "Rollback staging path is missing or unsafe before retirement."
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
  discard_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-discard.XXXXXXXXXX")"
  rmdir -- "$discard_path"
  mv -T -- "$ROLLBACK_RESTORE_STAGING" "$discard_path"
  sync -f "$STATE_ROOT"
  [[ -d "$discard_path" && ! -L "$discard_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$discard_path")" == 0:0:751 ]] \
    || die "Rollback staging retirement became unsafe."
  chmod 0700 "$discard_path"
  rm -rf -- "$discard_path"
  sync -f "$STATE_ROOT"
}

reconcile_upgrade_revision_namespace() {
  local live_namespace="$STATE_ROOT/revisions"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local live_mode
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"

  if path_is_present "$live_namespace"; then
    [[ -d "$live_namespace" && ! -L "$live_namespace" ]] \
      && [[ "$(stat -c '%u:%g' -- "$live_namespace")" == 0:0 ]] \
      || die "Refusing an unsafe live revision namespace during rollback recovery."
    reconcile_repository_revision_crash_artifacts "$live_namespace"
    live_mode="$(stat -c '%a' -- "$live_namespace")"
    case "$live_mode" in
      700)
        validate_upgrade_revision_namespace "$live_namespace" "" 700
        chmod 0751 "$live_namespace"
        sync -f "$live_namespace"
        ;;
      751)
        validate_upgrade_revision_namespace "$live_namespace"
        ;;
      *)
        die "Refusing a live revision namespace with unsafe permissions during rollback recovery."
        ;;
    esac
    if ! upgrade_revision_namespaces_match "$live_namespace" "$backup_namespace" "$revision_set"; then
      ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
        || die "Rollback found both an unrestored live namespace and an occupied quarantine path."
      mv -T -- "$live_namespace" "$ROLLBACK_QUARANTINE_PATH"
      sync -f "$STATE_ROOT"
      validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
    fi
  else
    path_is_present "$ROLLBACK_QUARANTINE_PATH" \
      || die "Rollback journal found neither the live nor quarantined revision namespace."
    validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  fi

  if ! path_is_present "$live_namespace"; then
    prepare_upgrade_restore_staging
    mv -T -- "$ROLLBACK_RESTORE_STAGING" "$live_namespace"
    sync -f "$STATE_ROOT"
  fi
  upgrade_revision_namespaces_match "$live_namespace" "$backup_namespace" "$revision_set" \
    || die "Rollback could not publish the exact pre-upgrade revision namespace."

  if path_is_present "$ROLLBACK_RESTORE_STAGING"; then
    retire_upgrade_restore_staging
  fi
  if ! path_is_present "$ROLLBACK_QUARANTINE_PATH"; then
    install -d -o root -g root -m 0700 "$ROLLBACK_QUARANTINE_PATH"
    sync -f "$STATE_ROOT"
  else
    validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  fi
  record_failed_upgrade_namespace "$ROLLBACK_QUARANTINE_PATH"
}
