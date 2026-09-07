# shellcheck shell=bash
# Validate and copy the legacy identity and publish its migration lineage.

# Validate a legacy sudoers rule before stopping anything, but remove it only
# after the hardened replacement has passed its routed readiness check.
REMOVE_LEGACY_SUDOERS=no
if path_is_present "$LEGACY_SUDOERS"; then
  if [[ -f "$LEGACY_SUDOERS" && ! -L "$LEGACY_SUDOERS" ]] \
      && grep -Fq '/opt/vpn-sub/ts-ctl.sh' "$LEGACY_SUDOERS"; then
    REMOVE_LEGACY_SUDOERS=yes
  else
    die "$LEGACY_SUDOERS exists but is not the legacy rule expected by this installer; inspect it manually."
  fi
fi

validate_regular_tree() {
  local tree_root="$1"
  local description="$2"
  local unsafe_entry
  [[ -d "$tree_root" && ! -L "$tree_root" ]] \
    || die "$description must be a directory, not a symlink."
  unsafe_entry="$(find "$tree_root" -xdev \
    \( ! -type d ! -type f -o -type f -links +1 \) -print -quit)"
  [[ -z "$unsafe_entry" ]] \
    || die "$description contains an unsupported symlink, special file, or hard link: $unsafe_entry"
}

compare_regular_trees() {
  local source_root="$1"
  local destination_root="$2"
  local source_entry relative_path destination_entry
  while IFS= read -r -d '' source_entry; do
    relative_path="${source_entry#"$source_root"/}"
    destination_entry="$destination_root/$relative_path"
    if [[ -d "$source_entry" ]]; then
      [[ -d "$destination_entry" && ! -L "$destination_entry" ]] \
        || die "The copied Tailscale state is missing directory $relative_path."
    else
      [[ -f "$destination_entry" && ! -L "$destination_entry" ]] \
        || die "The copied Tailscale state is missing file $relative_path."
      cmp -s -- "$source_entry" "$destination_entry" \
        || die "The copied Tailscale state does not match file $relative_path."
    fi
  done < <(find "$source_root" -xdev -mindepth 1 -print0)
  while IFS= read -r -d '' destination_entry; do
    relative_path="${destination_entry#"$destination_root"/}"
    [[ -e "$source_root/$relative_path" && ! -L "$source_root/$relative_path" ]] \
      || die "The copied Tailscale state contains unexpected entry $relative_path."
  done < <(find "$destination_root" -xdev -mindepth 1 -print0)
}

if [[ "$INSTALL_MODE" == migrate ]]; then
  [[ "$MIGRATION_APPROVED" == yes ]] || die "Internal error: legacy migration was not approved."
  STATE_COPY_ALREADY_COMPLETE=no

  if [[ "$COPY_LEGACY_STATE" == yes ]]; then
    [[ -d "$LEGACY_SOURCE_STATE" && ! -L "$LEGACY_SOURCE_STATE" ]] \
      || die "Legacy Tailscale state is missing at $LEGACY_SOURCE_STATE. Restore it from backup before retrying."
    [[ -n "$(find "$LEGACY_SOURCE_STATE" -xdev -mindepth 1 -print -quit)" ]] \
      || die "Legacy Tailscale state at $LEGACY_SOURCE_STATE is empty. Restore it before retrying so the Tailnet identity is not silently replaced."
    if path_is_present "$STATE_ROOT/tailscale"; then
      [[ -d "$STATE_ROOT/tailscale" && ! -L "$STATE_ROOT/tailscale" ]] \
        || die "$STATE_ROOT/tailscale is unsafe; preserve it and inspect it manually."
      if [[ -n "$(find "$STATE_ROOT/tailscale" -mindepth 1 -print -quit)" ]]; then
        if [[ "$MIGRATION_RESUME" == yes ]]; then
          validate_regular_tree "$STATE_ROOT/tailscale" "Previously copied Tailscale state"
          # The legacy service was restored after the failed attempt and may
          # have updated its authoritative state. Re-copy it after stopping the
          # service below instead of trusting this earlier snapshot.
          STATE_COPY_ALREADY_COMPLETE=no
        else
          die "$STATE_ROOT/tailscale already contains data without a migration marker. Preserve it and inspect it manually before retrying."
        fi
      fi
    fi
  else
    validate_regular_tree "$LEGACY_SOURCE_STATE" "Legacy Tailscale state"
    validate_regular_tree "$STATE_ROOT/tailscale" "Pre-copied Tailscale state"
    [[ -n "$(find "$STATE_ROOT/tailscale" -xdev -mindepth 1 -print -quit)" ]] \
      || die "Pre-copied Tailscale state is empty."
    if [[ "$MIGRATION_RESUME" == yes ]]; then
      # The failed candidate and then the restored legacy service can each
      # mutate their own copy. Refresh from the now-authoritative legacy tree
      # after it is stopped below instead of trusting the pre-attempt snapshot.
      STATE_COPY_ALREADY_COMPLETE=no
    else
      compare_regular_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"
      STATE_COPY_ALREADY_COMPLETE=yes
    fi
  fi

  echo "==> Stopping legacy services before copying their mutable Tailscale state"
  LEGACY_SERVICES_STOPPED=yes
  legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
  legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
  legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
  legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
  [[ "$legacy_sub_active_state" != active ]] || systemctl stop vpn-sub.service
  [[ "$legacy_singbox_active_state" != active ]] || systemctl stop sing-box.service
  [[ "$legacy_sub_enablement_state" != enabled ]] || systemctl disable vpn-sub.service
  [[ "$legacy_singbox_enablement_state" != enabled ]] || systemctl disable sing-box.service
  legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
  legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
  legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
  legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
  [[ "$legacy_sub_active_state" == inactive || "$legacy_sub_active_state" == failed ]] \
    || die "vpn-sub.service did not reach a conclusively stopped state."
  [[ "$legacy_singbox_active_state" == inactive || "$legacy_singbox_active_state" == failed ]] \
    || die "sing-box.service did not reach a conclusively stopped state."
  [[ "$legacy_sub_enablement_state" != enabled ]] \
    || die "vpn-sub.service remained enabled during its state handoff."
  [[ "$legacy_singbox_enablement_state" != enabled ]] \
    || die "sing-box.service remained enabled during its state handoff."
  [[ "$(sha256sum "$LEGACY_ENV_FILE" | cut -d' ' -f1)" == "$LEGACY_ENV_DIGEST" ]] \
    || die "$LEGACY_ENV_FILE changed after its reviewed dry run; retry the installer."
  [[ "$(sha256sum "$LEGACY_CONFIG_FILE" | cut -d' ' -f1)" == "$LEGACY_CONFIG_DIGEST" ]] \
    || die "$LEGACY_CONFIG_FILE changed after its reviewed dry run; retry the installer."

  if [[ "$STATE_COPY_ALREADY_COMPLETE" != yes ]]; then
    validate_regular_tree "$LEGACY_SOURCE_STATE" "Legacy Tailscale state"
    MIGRATION_STAGING="$(mktemp -d "$STATE_ROOT/.tailscale-migrate.XXXXXX")"
    chmod 0700 "$MIGRATION_STAGING"
    cp -a -- "$LEGACY_SOURCE_STATE/." "$MIGRATION_STAGING/"
    validate_regular_tree "$MIGRATION_STAGING" "Copied Tailscale state"
    compare_regular_trees "$LEGACY_SOURCE_STATE" "$MIGRATION_STAGING"
    find "$MIGRATION_STAGING" -xdev -exec chown -h vpn-runtime:vpn-runtime {} +
    chmod 0700 "$MIGRATION_STAGING"
    # Recheck at the last destructive boundary in case the source topology was
    # changed after review. Never remove a destination that aliases the only
    # authoritative legacy identity.
    if path_is_present "$STATE_ROOT/tailscale"; then
      validate_regular_tree "$STATE_ROOT/tailscale" "Previously copied Tailscale state"
      assert_distinct_migration_state_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"
      rm -rf -- "$STATE_ROOT/tailscale"
    fi
    mv -- "$MIGRATION_STAGING" "$STATE_ROOT/tailscale"
    MIGRATION_STAGING=""
  fi
  find "$STATE_ROOT/tailscale" -xdev -exec chown -h vpn-runtime:vpn-runtime {} +
  chmod 0700 "$STATE_ROOT/tailscale"
  if ! path_is_present "$MIGRATION_MARKER/state-copied"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-copied"
    sync -f "$MIGRATION_MARKER/state-copied"
    sync -f "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
  fi

  # This override is persisted only after the source tree has been copied and
  # byte-compared. The migration retains the original files plus a private
  # application-level backup under STATE_ROOT/legacy-backups.
  grep -Fq MIGRATION_STATE_DIR "$INSTALL_ROOT/src/migrations/legacy-v1-state.js" \
    || die "The installed migration module does not support the safe Tailscale state-directory override."
  create_migration_controller_environment "$STATE_ROOT/tailscale"

  echo "==> Final migration preview after the Tailscale state copy"
  inspect_legacy_deployment "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/migrations/legacy-v1-source.js"
  if path_is_present "$STATE_ROOT/current" || path_is_present "$STATE_ROOT/runtime"; then
    echo "==> Recovering the already published legacy migration"
    run_legacy_bootstrap 1 existing,recovered "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/state/bootstrap-service.js"
  else
    echo "==> Applying the explicitly approved legacy migration"
    # A fully authenticated immutable migration revision may have survived a
    # hard crash before either pointer. Its narrow recovery reports recovered.
    run_legacy_bootstrap 1 migrated,recovered "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/state/bootstrap-service.js"
  fi

  [[ -L "$STATE_ROOT/current" && -L "$STATE_ROOT/runtime" ]] \
    || die "Migration did not publish both atomic revision pointers."
  [[ -d "$STATE_ROOT/legacy-backups" ]] \
    && [[ -n "$(find "$STATE_ROOT/legacy-backups" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]] \
    || die "Migration did not preserve a private backup of the legacy configuration."
  [[ "$(sha256sum "$LEGACY_ENV_FILE" | cut -d' ' -f1)" == "$LEGACY_ENV_DIGEST" ]] \
    || die "$LEGACY_ENV_FILE changed during migration."
  [[ "$(sha256sum "$LEGACY_CONFIG_FILE" | cut -d' ' -f1)" == "$LEGACY_CONFIG_DIGEST" ]] \
    || die "$LEGACY_CONFIG_FILE changed during migration."
  MIGRATION_STATE_WAS_PUBLISHED=no
  if path_is_present "$MIGRATION_MARKER/state-published"; then
    MIGRATION_STATE_WAS_PUBLISHED=yes
  fi
  MIGRATION_API_KEY_FILE=""
  if [[ -s "$API_KEY_PATH" ]]; then
    MIGRATION_API_KEY_FILE="$API_KEY_PATH"
  fi
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "DATA_DIR=$STATE_ROOT" \
    "EXPECTED_STATE_DIRECTORY=$STATE_ROOT/tailscale" \
    "MIGRATION_LINEAGE_FILE=$MIGRATION_MARKER/lineage.json" \
    "MIGRATION_STATE_PUBLISHED=$MIGRATION_STATE_WAS_PUBLISHED" \
    "LEGACY_ENV_FILE=$LEGACY_ENV_FILE" \
    "LEGACY_CONFIG_FILE=$LEGACY_CONFIG_FILE" \
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
    "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL" \
    "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME" \
    "WS_PATH=$WS_PATH" \
    "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST" \
    "TS_API_KEY_FILE=$MIGRATION_API_KEY_FILE" \
    "RUNTIME_GID=$RUNTIME_GID" \
    "SUB_GID=$SUB_GID_VALUE" \
    "$NODE_BIN" --input-type=module --eval '
      import { RevisionRepository } from "/opt/vpn-gateway/src/state/repository.js";
      import { assertLegacyV1MigrationLineage } from "/opt/vpn-gateway/src/migrations/migration-lineage.js";
      const repository = new RevisionRepository(process.env.DATA_DIR, {
        runtimeGid: Number(process.env.RUNTIME_GID),
        subscriptionGid: Number(process.env.SUB_GID),
      });
      await assertLegacyV1MigrationLineage({
        dataDir: process.env.DATA_DIR,
        envPath: process.env.LEGACY_ENV_FILE,
        configPath: process.env.LEGACY_CONFIG_FILE,
        fallbackEnvironment: process.env,
        expectedStateDirectory: process.env.EXPECTED_STATE_DIRECTORY,
        lineagePath: process.env.MIGRATION_LINEAGE_FILE,
        statePublished: process.env.MIGRATION_STATE_PUBLISHED === "yes",
        repository,
      });
    '
  validate_migration_marker_file "$MIGRATION_MARKER/lineage.json"
  sync -f "$MIGRATION_MARKER/lineage.json"
  sync -f "$MIGRATION_MARKER"
  if ! path_is_present "$MIGRATION_MARKER/state-published"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-published"
    sync -f "$MIGRATION_MARKER/state-published"
    sync -f "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
  fi
fi
