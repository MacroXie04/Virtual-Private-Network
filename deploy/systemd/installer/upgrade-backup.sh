# shellcheck shell=bash
# Persist and validate the prior deployment and protected-state backup.

write_upgrade_metadata_value() {
  local name="$1"
  local value="$2"
  local target="$UPGRADE_BACKUP/rollback-metadata/$name"
  [[ "$name" =~ ^[a-z-]+$ && "$value" =~ ^(yes|no)$ ]] \
    || die "Internal upgrade rollback metadata is invalid."
  install -o root -g root -m 0600 /dev/null "$target"
  printf '%s\n' "$value" >"$target"
  sync -f "$target"
}

persist_upgrade_rollback_metadata() {
  write_upgrade_metadata_value install-root "$UPGRADE_HAD_INSTALL_ROOT"
  write_upgrade_metadata_value environment-root "$UPGRADE_HAD_ENV_ROOT"
  write_upgrade_metadata_value target-active "$UPGRADE_WAS_ACTIVE"
  write_upgrade_metadata_value target-enabled "$UPGRADE_WAS_ENABLED"
  write_upgrade_metadata_value sing-box-enabled "$UPGRADE_SINGBOX_WAS_ENABLED"
  write_upgrade_metadata_value unit-target "$UPGRADE_HAD_UNIT_TARGET"
  write_upgrade_metadata_value unit-controller "$UPGRADE_HAD_UNIT_CONTROLLER"
  write_upgrade_metadata_value unit-sing-box "$UPGRADE_HAD_UNIT_SING_BOX"
  write_upgrade_metadata_value unit-subscription "$UPGRADE_HAD_UNIT_SUBSCRIPTION"
  write_upgrade_metadata_value unit-admin "$UPGRADE_HAD_UNIT_ADMIN"
  write_upgrade_metadata_value unit-tunnel "$UPGRADE_HAD_UNIT_TUNNEL"
  sync -f "$UPGRADE_BACKUP/rollback-metadata"
  sync -f "$UPGRADE_BACKUP"
}

read_upgrade_journal_line() {
  local file_path="$1"
  local expected_pattern="$2"
  local label="$3"
  local value file_size
  [[ -f "$file_path" && ! -L "$file_path" ]] \
    && [[ "$(stat -c '%u:%g:%a:%h' -- "$file_path")" == 0:0:600:1 ]] \
    || die "$label is missing or unsafe: $file_path"
  file_size="$(stat -c '%s' -- "$file_path")"
  if [[ ! "$file_size" =~ ^[0-9]+$ ]] \
      || (( file_size <= 1 || file_size > 512 )); then
    die "$label has an invalid size: $file_path"
  fi
  value="$(<"$file_path")"
  [[ "$value" =~ $expected_pattern ]] \
    || die "$label has invalid content: $file_path"
  (( file_size == ${#value} + 1 )) \
    || die "$label must contain exactly one newline-terminated value: $file_path"
  printf '%s\n' "$value"
}

load_upgrade_rollback_metadata() {
  local metadata_root="$UPGRADE_BACKUP/rollback-metadata"
  local unexpected_entry
  [[ -d "$metadata_root" && ! -L "$metadata_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$metadata_root")" == 0:0:700 ]] \
    || die "Upgrade rollback metadata is missing or unsafe: $metadata_root"
  unexpected_entry="$(find "$metadata_root" -mindepth 1 -maxdepth 1 \
    ! -name install-root \
    ! -name environment-root \
    ! -name target-active \
    ! -name target-enabled \
    ! -name sing-box-enabled \
    ! -name unit-target \
    ! -name unit-controller \
    ! -name unit-sing-box \
    ! -name unit-subscription \
    ! -name unit-admin \
    ! -name unit-tunnel \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback metadata contains an unexpected entry: $unexpected_entry"
  UPGRADE_HAD_INSTALL_ROOT="$(read_upgrade_journal_line "$metadata_root/install-root" '^(yes|no)$' 'Upgrade install-root metadata')"
  UPGRADE_HAD_ENV_ROOT="$(read_upgrade_journal_line "$metadata_root/environment-root" '^(yes|no)$' 'Upgrade environment-root metadata')"
  UPGRADE_WAS_ACTIVE="$(read_upgrade_journal_line "$metadata_root/target-active" '^(yes|no)$' 'Upgrade target-active metadata')"
  UPGRADE_WAS_ENABLED="$(read_upgrade_journal_line "$metadata_root/target-enabled" '^(yes|no)$' 'Upgrade target-enabled metadata')"
  UPGRADE_SINGBOX_WAS_ENABLED="$(read_upgrade_journal_line "$metadata_root/sing-box-enabled" '^(yes|no)$' 'Upgrade sing-box-enabled metadata')"
  UPGRADE_HAD_UNIT_TARGET="$(read_upgrade_journal_line "$metadata_root/unit-target" '^(yes|no)$' 'Upgrade target-unit metadata')"
  UPGRADE_HAD_UNIT_CONTROLLER="$(read_upgrade_journal_line "$metadata_root/unit-controller" '^(yes|no)$' 'Upgrade controller-unit metadata')"
  UPGRADE_HAD_UNIT_SING_BOX="$(read_upgrade_journal_line "$metadata_root/unit-sing-box" '^(yes|no)$' 'Upgrade sing-box-unit metadata')"
  UPGRADE_HAD_UNIT_SUBSCRIPTION="$(read_upgrade_journal_line "$metadata_root/unit-subscription" '^(yes|no)$' 'Upgrade subscription-unit metadata')"
  UPGRADE_HAD_UNIT_ADMIN="$(read_upgrade_journal_line "$metadata_root/unit-admin" '^(yes|no)$' 'Upgrade admin-unit metadata')"
  if path_is_present "$metadata_root/unit-tunnel"; then
    UPGRADE_HAD_UNIT_TUNNEL="$(read_upgrade_journal_line "$metadata_root/unit-tunnel" '^(yes|no)$' 'Upgrade tunnel-unit metadata')"
  else
    # Rollback metadata published by the immediately preceding deployment did
    # not know about the Tunnel unit. Absence therefore means the old unit was
    # absent; a corresponding backup file is rejected below.
    UPGRADE_HAD_UNIT_TUNNEL=no
  fi
}

backup_upgrade_revision_namespace() {
  local live_namespace="$STATE_ROOT/revisions"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local revision_path
  validate_upgrade_revision_namespace "$live_namespace"
  install -o root -g root -m 0600 /dev/null "$revision_set"
  while IFS= read -r -d '' revision_path; do
    printf '%s\n' "${revision_path##*/}" >>"$revision_set"
  done < <(find "$live_namespace" -mindepth 1 -maxdepth 1 -print0)
  cp -a -- "$live_namespace" "$backup_namespace"
  compare_upgrade_revision_namespaces "$live_namespace" "$backup_namespace" "$revision_set"
}

backup_upgrade_pointer() {
  local pointer_name="$1"
  local pointer_path="$STATE_ROOT/$pointer_name"
  local pointer_target
  if path_is_present "$pointer_path"; then
    [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
      || die "$pointer_path must be a root-owned symbolic link before upgrade."
    pointer_target="$(readlink -- "$pointer_path")"
    validate_upgrade_pointer_target "$pointer_target"
    printf '%s\n' "$pointer_target" >"$UPGRADE_BACKUP/protected-state/$pointer_name.target"
    chmod 0600 "$UPGRADE_BACKUP/protected-state/$pointer_name.target"
    chown root:root "$UPGRADE_BACKUP/protected-state/$pointer_name.target"
  else
    install -o root -g root -m 0600 /dev/null \
      "$UPGRADE_BACKUP/protected-state/$pointer_name.absent"
  fi
}

backup_upgrade_protected_state() {
  local maintenance_path="$STATE_ROOT/maintenance"
  install -d -o root -g root -m 0700 "$UPGRADE_BACKUP/protected-state"
  backup_upgrade_revision_namespace
  backup_upgrade_pointer current
  backup_upgrade_pointer runtime
  if path_is_present "$maintenance_path"; then
    [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
      || die "$maintenance_path must be a root-owned, singly linked mode-0600 regular file."
    cp -a -- "$maintenance_path" "$UPGRADE_BACKUP/protected-state/maintenance.present"
  else
    install -o root -g root -m 0600 /dev/null \
      "$UPGRADE_BACKUP/protected-state/maintenance.absent"
  fi
  UPGRADE_STATE_BACKUP_READY=yes
}

validate_upgrade_backup_variant() {
  local base_path="$1"
  local present_suffix="$2"
  local absent_suffix="$3"
  local label="$4"
  local present_path="$base_path.$present_suffix"
  local absent_path="$base_path.$absent_suffix"
  local variant_count=0
  if path_is_present "$present_path"; then
    ((variant_count += 1))
    [[ -f "$present_path" && ! -L "$present_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$present_path")" == 0:0:600:1 ]] \
      || die "$label present journal is unsafe: $present_path"
  fi
  if path_is_present "$absent_path"; then
    ((variant_count += 1))
    [[ -f "$absent_path" && ! -L "$absent_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h:%s' -- "$absent_path")" == 0:0:600:1:0 ]] \
      || die "$label absence journal is unsafe: $absent_path"
  fi
  (( variant_count == 1 )) \
    || die "$label journal must contain exactly one present/absent variant."
}

validate_upgrade_rollback_backup() {
  local protected_root="$UPGRADE_BACKUP/protected-state"
  local units_root="$UPGRADE_BACKUP/units"
  local revision_set="$protected_root/revision-set"
  local unexpected_entry pointer_name pointer_target unit_file unit_flag record_staging
  local record_staging_count=0
  [[ "$UPGRADE_BACKUP" =~ ^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback backup path is not canonical: $UPGRADE_BACKUP"
  [[ -d "$UPGRADE_BACKUP" && ! -L "$UPGRADE_BACKUP" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_BACKUP")" == 0:0:700 ]] \
    || die "Upgrade rollback backup is missing or unsafe: $UPGRADE_BACKUP"
  unexpected_entry="$(find "$UPGRADE_BACKUP" -mindepth 1 -maxdepth 1 \
    ! -name install-root \
    ! -name environment-root \
    ! -name units \
    ! -name rollback-metadata \
    ! -name protected-state \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback backup contains an unexpected entry: $unexpected_entry"
  [[ -d "$protected_root" && ! -L "$protected_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$protected_root")" == 0:0:700 ]] \
    || die "Upgrade protected-state backup is missing or unsafe."
  unexpected_entry="$(find "$protected_root" -mindepth 1 -maxdepth 1 \
    ! -name revisions-snapshot \
    ! -name revision-set \
    ! -name current.target \
    ! -name current.absent \
    ! -name runtime.target \
    ! -name runtime.absent \
    ! -name maintenance.present \
    ! -name maintenance.absent \
    ! -name failed-revision-namespace \
    ! -name '.failed-revision-namespace.*' \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade protected-state backup contains an unexpected entry: $unexpected_entry"
  while IFS= read -r -d '' record_staging; do
    [[ "${record_staging##*/}" =~ ^\.failed-revision-namespace\.[A-Za-z0-9]{10}$ ]] \
      || die "Upgrade protected-state backup contains an invalid record staging name."
    [[ -f "$record_staging" && ! -L "$record_staging" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$record_staging")" == 0:0:600:1 ]] \
      && [[ "$(stat -c '%s' -- "$record_staging")" -le 512 ]] \
      || die "Failed revision namespace staging record is unsafe: $record_staging"
    ((record_staging_count += 1))
  done < <(find "$protected_root" -mindepth 1 -maxdepth 1 \
    -name '.failed-revision-namespace.*' -print0)
  (( record_staging_count <= 1 )) \
    || die "Upgrade protected-state backup contains multiple staged namespace records."
  validate_upgrade_revision_namespace "$protected_root/revisions-snapshot" "$revision_set"
  for pointer_name in current runtime; do
    validate_upgrade_backup_variant "$protected_root/$pointer_name" target absent "Upgrade $pointer_name pointer"
    if [[ -f "$protected_root/$pointer_name.target" ]]; then
      pointer_target="$(read_upgrade_journal_line \
        "$protected_root/$pointer_name.target" \
        '^revisions/[0-9]{16}-[0-9a-f]{16}$' \
        "Upgrade $pointer_name pointer")"
      grep -Fxq -- "${pointer_target#revisions/}" "$revision_set" \
        || die "Upgrade $pointer_name pointer is absent from the protected revision set."
    fi
  done
  validate_upgrade_backup_variant "$protected_root/maintenance" present absent "Upgrade maintenance"
  if [[ -f "$protected_root/maintenance.present" ]]; then
    [[ "$(stat -c '%s' -- "$protected_root/maintenance.present")" -le $((64 * 1024)) ]] \
      || die "Upgrade maintenance backup exceeds its storage bound."
  fi
  load_upgrade_rollback_metadata
  if [[ "$UPGRADE_HAD_INSTALL_ROOT" == yes ]]; then
    validate_fixed_directory "$UPGRADE_BACKUP/install-root"
    [[ -d "$UPGRADE_BACKUP/install-root" ]] \
      || die "Upgrade metadata references a missing install-root backup."
  else
    ! path_is_present "$UPGRADE_BACKUP/install-root" \
      || die "Upgrade metadata marks install-root absent but a backup is present."
  fi
  if [[ "$UPGRADE_HAD_ENV_ROOT" == yes ]]; then
    validate_fixed_directory "$UPGRADE_BACKUP/environment-root"
    [[ -d "$UPGRADE_BACKUP/environment-root" ]] \
      || die "Upgrade metadata references a missing environment-root backup."
  else
    ! path_is_present "$UPGRADE_BACKUP/environment-root" \
      || die "Upgrade metadata marks environment-root absent but a backup is present."
  fi
  [[ -d "$units_root" && ! -L "$units_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$units_root")" == 0:0:700 ]] \
    || die "Upgrade unit backup is missing or unsafe."
  unexpected_entry="$(find "$units_root" -mindepth 1 -maxdepth 1 \
    ! -name vpn-gateway.target \
    ! -name vpn-gateway-controller.service \
    ! -name vpn-gateway-sing-box.service \
    ! -name vpn-gateway-subscription.service \
    ! -name vpn-gateway-admin.service \
    ! -name vpn-gateway-tunnel.service \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade unit backup contains an unexpected entry: $unexpected_entry"
  for unit_file in "${UNIT_FILES[@]}"; do
    case "$unit_file" in
      vpn-gateway.target) unit_flag="$UPGRADE_HAD_UNIT_TARGET" ;;
      vpn-gateway-controller.service) unit_flag="$UPGRADE_HAD_UNIT_CONTROLLER" ;;
      vpn-gateway-sing-box.service) unit_flag="$UPGRADE_HAD_UNIT_SING_BOX" ;;
      vpn-gateway-subscription.service) unit_flag="$UPGRADE_HAD_UNIT_SUBSCRIPTION" ;;
      vpn-gateway-admin.service) unit_flag="$UPGRADE_HAD_UNIT_ADMIN" ;;
      vpn-gateway-tunnel.service) unit_flag="$UPGRADE_HAD_UNIT_TUNNEL" ;;
    esac
    if [[ "$unit_flag" == yes ]]; then
      validate_fixed_file "$units_root/$unit_file"
      [[ -f "$units_root/$unit_file" ]] \
        || die "Upgrade metadata references a missing unit backup: $unit_file"
    else
      ! path_is_present "$units_root/$unit_file" \
        || die "Upgrade metadata marks a unit absent but its backup is present: $unit_file"
    fi
  done
}
