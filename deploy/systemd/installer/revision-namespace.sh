# shellcheck shell=bash
# Track transaction state and validate every protected revision namespace.

SECRET_STAGING=""
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
DEPLOYMENT_HANDOFF_COMPLETE=no

validate_upgrade_revision() {
  local revision_path="$1"
  local revision_name="${2:-${revision_path##*/}}"
  local expected_name file_name expected_identity actual_identity expected_max_bytes file_size unexpected_entry
  expected_name="$revision_name"
  [[ "$expected_name" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
    || die "Protected revision name is invalid: $expected_name"
  [[ -d "$revision_path" && ! -L "$revision_path" ]] \
    || die "Protected revision is missing or unsafe: $revision_path"
  [[ "$(stat -c '%u:%a' -- "$revision_path")" == 0:751 ]] \
    || die "Protected revision directory must be root-owned with mode 0751: $revision_path"
  unexpected_entry="$(find "$revision_path" -mindepth 1 -maxdepth 1 \
    ! -name manifest.json \
    ! -name state.json \
    ! -name sing-box.json \
    ! -name subscription-view.json \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Protected revision contains an unexpected entry: $unexpected_entry"
  for file_name in manifest.json state.json sing-box.json subscription-view.json; do
    [[ -f "$revision_path/$file_name" && ! -L "$revision_path/$file_name" ]] \
      || die "Protected revision file is missing or unsafe: $revision_path/$file_name"
    case "$file_name" in
      manifest.json|state.json)
        expected_identity=0:0:600:1
        if [[ "$file_name" == manifest.json ]]; then
          expected_max_bytes=$((64 * 1024))
        else
          expected_max_bytes=$((1024 * 1024))
        fi
        ;;
      sing-box.json)
        expected_identity="0:$RUNTIME_GID:640:1"
        expected_max_bytes=$((4 * 1024 * 1024))
        ;;
      subscription-view.json)
        expected_identity="0:$SUB_GID_VALUE:640:1"
        expected_max_bytes=$((1024 * 1024))
        ;;
    esac
    actual_identity="$(stat -c '%u:%g:%a:%h' -- "$revision_path/$file_name")"
    [[ "$actual_identity" == "$expected_identity" ]] \
      || die "Protected revision file has unsafe ownership, mode, or link count: $revision_path/$file_name"
    file_size="$(stat -c '%s' -- "$revision_path/$file_name")"
    if [[ ! "$file_size" =~ ^[0-9]+$ ]] \
        || (( file_size == 0 || file_size > expected_max_bytes )); then
      die "Protected revision file is empty or exceeds its storage bound: $revision_path/$file_name"
    fi
  done
  assert_supported_revision_file "$revision_path/state.json"
}

assert_supported_revision_file() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "STATE_FILE=$1" \
    "REPOSITORY_FILES_MODULE=$REPO_DIR/src/state/filesystem/files.js" \
    "$NODE_BIN" --input-type=module --eval '
      import { pathToFileURL } from "node:url";
      const { readNoFollow } = await import(pathToFileURL(process.env.REPOSITORY_FILES_MODULE).href);
      const bytes = await readNoFollow(process.env.STATE_FILE, {
        maxBytes: 1024 * 1024, expectedMode: 0o600,
      });
      let state;
      try { state = JSON.parse(bytes.toString("utf8")); } catch { process.exit(0); }
      if (Number.isInteger(state?.schemaVersion) && state.schemaVersion !== 3) {
        throw new Error("Unsupported state schema; preserve this backup and use a new data directory.");
      }
    '
}

validate_upgrade_pointer_target() {
  local pointer_target="$1"
  [[ "$pointer_target" =~ ^revisions/[0-9]{16}-[0-9a-f]{16}$ ]] \
    || die "Protected revision pointer target is invalid: $pointer_target"
  validate_upgrade_revision "$STATE_ROOT/$pointer_target"
}

validate_upgrade_temporary_revision() {
  local temporary_path="$1"
  local temporary_name="${temporary_path##*/}"
  local directory_mode file_name unexpected_entry stat_record owner_id group_id permission_mode link_count file_size max_bytes
  [[ "$temporary_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
      || "$temporary_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || die "Temporary revision name is invalid: $temporary_name"
  [[ -d "$temporary_path" && ! -L "$temporary_path" ]] \
    && [[ "$(stat -c '%u' -- "$temporary_path")" == 0 ]] \
    || die "Temporary revision directory is unsafe: $temporary_path"
  group_id="$(stat -c '%g' -- "$temporary_path")"
  [[ "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ]] \
    || die "Temporary revision directory has an unsafe group: $temporary_path"
  directory_mode="$(stat -c '%a' -- "$temporary_path")"
  [[ "$directory_mode" == 700 || "$directory_mode" == 751 ]] \
    || die "Temporary revision directory has unsafe permissions: $temporary_path"
  unexpected_entry="$(find "$temporary_path" -mindepth 1 -maxdepth 1 \
    ! -name manifest.json \
    ! -name state.json \
    ! -name sing-box.json \
    ! -name subscription-view.json \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Temporary revision contains an unexpected entry: $unexpected_entry"
  for file_name in manifest.json state.json sing-box.json subscription-view.json; do
    path_is_present "$temporary_path/$file_name" || continue
    [[ -f "$temporary_path/$file_name" && ! -L "$temporary_path/$file_name" ]] \
      || die "Temporary revision contains an unsafe file: $temporary_path/$file_name"
    stat_record="$(stat -c '%u:%g:%a:%h' -- "$temporary_path/$file_name")"
    IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
    [[ "$owner_id" == 0 && "$link_count" == 1 ]] \
      || die "Temporary revision file has unsafe ownership or links: $temporary_path/$file_name"
    case "$file_name" in
      manifest.json)
        [[ "$permission_mode" == 600 \
            && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
          || die "Temporary manifest has unsafe permissions."
        max_bytes=$((64 * 1024))
        ;;
      state.json)
        [[ "$permission_mode" == 600 \
            && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
          || die "Temporary state has unsafe permissions."
        max_bytes=$((1024 * 1024))
        ;;
      sing-box.json)
        if [[ "$group_id" != 0 && "$group_id" != "$ADMIN_GID_VALUE" \
            && "$group_id" != "$RUNTIME_GID" ]] \
            || [[ "$permission_mode" != 600 && "$permission_mode" != 640 ]]; then
          die "Temporary sing-box configuration has unsafe permissions."
        fi
        max_bytes=$((4 * 1024 * 1024))
        ;;
      subscription-view.json)
        if [[ "$group_id" != 0 && "$group_id" != "$ADMIN_GID_VALUE" \
            && "$group_id" != "$SUB_GID_VALUE" ]] \
            || [[ "$permission_mode" != 600 && "$permission_mode" != 640 ]]; then
          die "Temporary subscription view has unsafe permissions."
        fi
        max_bytes=$((1024 * 1024))
        ;;
    esac
    file_size="$(stat -c '%s' -- "$temporary_path/$file_name")"
    if [[ ! "$file_size" =~ ^[0-9]+$ ]] || (( file_size > max_bytes )); then
      die "Temporary revision file exceeds its storage bound: $temporary_path/$file_name"
    fi
  done
}

# Earlier service units ran the root controller with vpn-admin as its effective group.
# Their root-owned private files could therefore inherit that group even though
# group permission bits were closed. Normalize only that exact, known-safe
# historical shape after the service set is stopped and before snapshotting it.
normalize_upgrade_repository_ownership() {
  local namespace_path="$STATE_ROOT/revisions"
  local revision_path revision_name file_path file_name stat_record owner_id group_id permission_mode link_count
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$namespace_path")" == 0:0:751 ]] \
    || die "Revision namespace is unsafe before ownership normalization."
  while IFS= read -r -d '' revision_path; do
    revision_name="${revision_path##*/}"
    [[ "$revision_name" =~ ^[0-9]{16}-[0-9a-f]{16}$ \
        || "$revision_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        || "$revision_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
      || die "Revision namespace contains an unexpected entry before ownership normalization: $revision_path"
    [[ -d "$revision_path" && ! -L "$revision_path" ]] \
      || die "Revision directory is unsafe before ownership normalization: $revision_path"
    stat_record="$(stat -c '%u:%g:%a' -- "$revision_path")"
    IFS=: read -r owner_id group_id permission_mode <<<"$stat_record"
    [[ "$owner_id" == 0 \
        && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) \
        && ( "$permission_mode" == 700 || "$permission_mode" == 751 ) ]] \
      || die "Revision directory has unsafe ownership or mode: $revision_path"
    if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
      chown root:root "$revision_path"
    fi
    while IFS= read -r -d '' file_path; do
      file_name="${file_path##*/}"
      case "$file_name" in
        manifest.json|state.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Private revision entry is unsafe before ownership normalization: $file_path"
          stat_record="$(stat -c '%u:%g:%a:%h' -- "$file_path")"
          IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
          [[ "$owner_id" == 0 && "$permission_mode" == 600 && "$link_count" == 1 \
              && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
            || die "Private revision entry has unsafe ownership or mode: $file_path"
          if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
            chown root:root "$file_path"
          fi
          ;;
        sing-box.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Runtime projection is unsafe before ownership normalization: $file_path"
          ;;
        subscription-view.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Subscription projection is unsafe before ownership normalization: $file_path"
          ;;
        *) die "Revision directory contains an unexpected entry: $file_path" ;;
      esac
    done < <(find "$revision_path" -mindepth 1 -maxdepth 1 -print0)
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
  if path_is_present "$STATE_ROOT/maintenance"; then
    [[ -f "$STATE_ROOT/maintenance" && ! -L "$STATE_ROOT/maintenance" ]] \
      || die "Maintenance marker is unsafe before ownership normalization."
    stat_record="$(stat -c '%u:%g:%a:%h' -- "$STATE_ROOT/maintenance")"
    IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
    [[ "$owner_id" == 0 && "$permission_mode" == 600 && "$link_count" == 1 \
        && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
      || die "Maintenance marker has unsafe ownership or mode."
    if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
      chown root:root "$STATE_ROOT/maintenance"
    fi
  fi
  sync -f "$namespace_path"
  sync -f "$STATE_ROOT"
}

reconcile_repository_revision_crash_artifacts() {
  local namespace_path="$1"
  local temporary_path temporary_name retirement_path
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$namespace_path")" == 0:0 ]] \
    || die "Revision namespace is unsafe while reconciling repository crash artifacts."
  while IFS= read -r -d '' temporary_path; do
    temporary_name="${temporary_path##*/}"
    if [[ "$temporary_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        || "$temporary_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      validate_upgrade_temporary_revision "$temporary_path"
      retirement_path="$(mktemp -d "$STATE_ROOT/.repository-crash-artifact.XXXXXXXXXX")"
      rmdir -- "$retirement_path"
      mv -T -- "$temporary_path" "$retirement_path"
      sync -f "$namespace_path"
      sync -f "$STATE_ROOT"
      chmod 0700 "$retirement_path"
      rm -rf -- "$retirement_path"
      sync -f "$STATE_ROOT"
    fi
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
}

validate_upgrade_revision_namespace() {
  local namespace_path="$1"
  local expected_set="${2:-}"
  local expected_mode="${3:-751}"
  local revision_path revision_id file_name file_size
  local revision_count=0
  local expected_count=0
  local total_bytes=0
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    || die "Revision namespace is missing or unsafe: $namespace_path"
  [[ "$(stat -c '%u:%g:%a' -- "$namespace_path")" == "0:0:$expected_mode" ]] \
    || die "Revision namespace must be root-owned with mode 0$expected_mode: $namespace_path"
  if [[ -n "$expected_set" ]]; then
    [[ -f "$expected_set" && ! -L "$expected_set" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$expected_set")" == 0:0:600:1 ]] \
      || die "Upgrade revision-set journal is missing or unsafe: $expected_set"
  fi
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    if [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]]; then
      validate_upgrade_revision "$revision_path"
      if [[ -n "$expected_set" ]]; then
        grep -Fxq -- "$revision_id" "$expected_set" \
          || die "Revision namespace contains a revision absent from the upgrade journal: $revision_id"
      fi
      for file_name in manifest.json state.json sing-box.json subscription-view.json; do
        file_size="$(stat -c '%s' -- "$revision_path/$file_name")"
        (( total_bytes += file_size ))
      done
    else
      die "Revision namespace contains an unexpected entry: $revision_path"
    fi
    (( revision_count += 1 ))
    (( revision_count <= MAX_UPGRADE_REVISIONS \
        && total_bytes <= MAX_UPGRADE_REVISION_BYTES )) \
      || die "Revision namespace exceeds the supported rollback snapshot budget."
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
  if [[ -n "$expected_set" ]]; then
    while IFS= read -r revision_id; do
      [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
        || die "Upgrade revision-set journal contains an invalid revision id."
      [[ -d "$namespace_path/$revision_id" && ! -L "$namespace_path/$revision_id" ]] \
        || die "Upgrade revision-set journal references a missing revision: $revision_id"
      (( expected_count += 1 ))
    done <"$expected_set"
    [[ "$expected_count" == "$revision_count" ]] \
      || die "Revision namespace does not exactly match the upgrade revision-set journal."
  fi
}

compare_upgrade_revision_namespaces() {
  local left_namespace="$1"
  local right_namespace="$2"
  local revision_set="$3"
  local revision_id file_name
  validate_upgrade_revision_namespace "$left_namespace" "$revision_set"
  validate_upgrade_revision_namespace "$right_namespace" "$revision_set"
  while IFS= read -r revision_id; do
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      cmp -s -- \
        "$left_namespace/$revision_id/$file_name" \
        "$right_namespace/$revision_id/$file_name" \
        || die "Revision snapshot differs from the stopped deployment: $revision_id/$file_name"
    done
  done <"$revision_set"
}

upgrade_revision_namespaces_match() {
  local live_namespace="$1"
  local backup_namespace="$2"
  local revision_set="$3"
  local revision_path revision_id file_name live_count=0 expected_count=0
  validate_upgrade_revision_namespace "$live_namespace"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    grep -Fxq -- "$revision_id" "$revision_set" || return 1
    ((live_count += 1))
  done < <(find "$live_namespace" -mindepth 1 -maxdepth 1 -print0)
  while IFS= read -r revision_id; do
    ((expected_count += 1))
    [[ -d "$live_namespace/$revision_id" && ! -L "$live_namespace/$revision_id" ]] \
      || return 1
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      cmp -s -- \
        "$live_namespace/$revision_id/$file_name" \
        "$backup_namespace/$revision_id/$file_name" \
        || return 1
    done
  done <"$revision_set"
  [[ "$live_count" == "$expected_count" ]]
}
