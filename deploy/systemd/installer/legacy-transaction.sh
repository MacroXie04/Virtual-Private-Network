# shellcheck shell=bash
# Retire a committed migration or journal and quiesce a new legacy cutover.

cleanup_committed_migration_work() {
  local unexpected_entry marker_name
  [[ "$COMMITTED_MIGRATION_CLEANUP" == yes ]] || return 0
  [[ -d "$MIGRATION_MARKER" && ! -L "$MIGRATION_MARKER" ]] \
    || die "$MIGRATION_MARKER must be a directory, not a symlink."
  [[ "$(stat -c '%u:%a' -- "$MIGRATION_MARKER")" == 0:700 ]] \
    || die "$MIGRATION_MARKER must be owned by root with mode 0700."
  unexpected_entry="$(find "$MIGRATION_MARKER" -mindepth 1 -maxdepth 1 \
    ! -name env.sha256 \
    ! -name config.sha256 \
    ! -name source-state \
    ! -name sub-active \
    ! -name sub-enabled \
    ! -name sing-box-active \
    ! -name sing-box-enabled \
    ! -name state-copied \
    ! -name state-published \
    ! -name lineage.json \
    ! -name committed \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Committed migration work contains an unexpected entry: $unexpected_entry"
  for marker_name in \
    env.sha256 config.sha256 source-state \
    sub-active sub-enabled sing-box-active sing-box-enabled \
    state-copied state-published lineage.json committed; do
    if path_is_present "$MIGRATION_MARKER/$marker_name"; then
      [[ -f "$MIGRATION_MARKER/$marker_name" && ! -L "$MIGRATION_MARKER/$marker_name" ]] \
        || die "Committed migration work contains an unsafe entry: $MIGRATION_MARKER/$marker_name"
      [[ "$(stat -c '%u:%a:%h' -- "$MIGRATION_MARKER/$marker_name")" == 0:600:1 ]] \
        || die "Committed migration work entry has unsafe ownership, mode, or link count: $MIGRATION_MARKER/$marker_name"
    fi
  done
  rm -f -- \
    "$MIGRATION_MARKER/env.sha256" \
    "$MIGRATION_MARKER/config.sha256" \
    "$MIGRATION_MARKER/source-state" \
    "$MIGRATION_MARKER/sub-active" \
    "$MIGRATION_MARKER/sub-enabled" \
    "$MIGRATION_MARKER/sing-box-active" \
    "$MIGRATION_MARKER/sing-box-enabled" \
    "$MIGRATION_MARKER/state-copied" \
    "$MIGRATION_MARKER/state-published" \
    "$MIGRATION_MARKER/lineage.json" \
    "$MIGRATION_MARKER/committed"
  rmdir -- "$MIGRATION_MARKER"
}

cleanup_committed_migration_work

if [[ "$INSTALL_MODE" == migrate ]]; then
  if [[ "$MIGRATION_RESUME" == yes ]]; then
    unexpected_marker_entry="$(find "$MIGRATION_MARKER" -mindepth 1 -maxdepth 1 \
      ! -name env.sha256 \
      ! -name config.sha256 \
      ! -name source-state \
      ! -name sub-active \
      ! -name sub-enabled \
      ! -name sing-box-active \
      ! -name sing-box-enabled \
      ! -name state-copied \
      ! -name state-published \
      ! -name lineage.json \
      ! -name committed \
      -print -quit)"
    [[ -z "$unexpected_marker_entry" ]] \
      || die "Migration marker contains an unexpected entry: $unexpected_marker_entry"
    for marker_name in env.sha256 config.sha256 source-state; do
      validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
    done
    read -r marker_env_digest <"$MIGRATION_MARKER/env.sha256"
    read -r marker_config_digest <"$MIGRATION_MARKER/config.sha256"
    read -r marker_source_state <"$MIGRATION_MARKER/source-state"
    [[ "$marker_env_digest" =~ ^[a-f0-9]{64}$ && "$marker_env_digest" == "$LEGACY_ENV_DIGEST" ]] \
      || die "$LEGACY_ENV_FILE no longer matches the interrupted migration. Restore the reviewed original before retrying."
    [[ "$marker_config_digest" =~ ^[a-f0-9]{64}$ && "$marker_config_digest" == "$LEGACY_CONFIG_DIGEST" ]] \
      || die "$LEGACY_CONFIG_FILE no longer matches the interrupted migration. Restore the reviewed original before retrying."
    [[ "$marker_source_state" == "$LEGACY_SOURCE_STATE" ]] \
      || die "The legacy Tailscale state path no longer matches the interrupted migration."
    for marker_name in sub-active sub-enabled sing-box-active sing-box-enabled state-copied state-published lineage.json; do
      if path_is_present "$MIGRATION_MARKER/$marker_name"; then
        validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
      fi
    done
    path_is_present "$MIGRATION_MARKER/sub-active" && LEGACY_SUB_WAS_ACTIVE=yes || true
    path_is_present "$MIGRATION_MARKER/sub-enabled" && LEGACY_SUB_WAS_ENABLED=yes || true
    path_is_present "$MIGRATION_MARKER/sing-box-active" && LEGACY_SINGBOX_WAS_ACTIVE=yes || true
    path_is_present "$MIGRATION_MARKER/sing-box-enabled" && LEGACY_SINGBOX_WAS_ENABLED=yes || true
    echo "==> Resuming the explicitly approved legacy migration recorded in $MIGRATION_MARKER"

    # A power loss does not run the EXIT trap. If it happened after candidate
    # readiness but before the outer commit marker, the replacement units can
    # still be live even though the legacy migration remains uncommitted. Stop
    # every possible new writer before replacing code or mutable tsnet state.
    # Mark the legacy handoff active first so any later failure restores the
    # exact legacy active/enablement state recorded in the durable marker.
    LEGACY_SERVICES_STOPPED=yes
    hold_migration_target_disabled
    for service_name in \
      vpn-gateway.target \
      vpn-gateway-controller.service \
      vpn-gateway-sing-box.service \
      vpn-gateway-subscription.service \
      vpn-gateway-admin.service; do
      stop_unit_if_active_strict "$service_name" yes
    done
    stop_unit_if_active_strict vpn-gateway-tunnel.service yes
  else
    legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
    legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
    legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
    legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
    if [[ "$legacy_sub_active_state" == active ]]; then
      LEGACY_SUB_WAS_ACTIVE=yes
    fi
    if [[ "$legacy_singbox_active_state" == active ]]; then
      LEGACY_SINGBOX_WAS_ACTIVE=yes
    fi
    if [[ "$legacy_sub_enablement_state" == enabled ]]; then
      LEGACY_SUB_WAS_ENABLED=yes
    fi
    if [[ "$legacy_singbox_enablement_state" == enabled ]]; then
      LEGACY_SINGBOX_WAS_ENABLED=yes
    fi

    MIGRATION_MARKER_STAGING="$(mktemp -d "$STATE_ROOT/.legacy-migration-marker.XXXXXXXXXX")"
    chmod 0700 "$MIGRATION_MARKER_STAGING"
    printf '%s\n' "$LEGACY_ENV_DIGEST" >"$MIGRATION_MARKER_STAGING/env.sha256"
    printf '%s\n' "$LEGACY_CONFIG_DIGEST" >"$MIGRATION_MARKER_STAGING/config.sha256"
    printf '%s\n' "$LEGACY_SOURCE_STATE" >"$MIGRATION_MARKER_STAGING/source-state"
    chmod 0600 \
      "$MIGRATION_MARKER_STAGING/env.sha256" \
      "$MIGRATION_MARKER_STAGING/config.sha256" \
      "$MIGRATION_MARKER_STAGING/source-state"
    [[ "$LEGACY_SUB_WAS_ACTIVE" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sub-active"
    [[ "$LEGACY_SUB_WAS_ENABLED" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sub-enabled"
    [[ "$LEGACY_SINGBOX_WAS_ACTIVE" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sing-box-active"
    [[ "$LEGACY_SINGBOX_WAS_ENABLED" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sing-box-enabled"
    chown -R root:root "$MIGRATION_MARKER_STAGING"
    while IFS= read -r -d '' marker_file; do
      sync -f "$marker_file"
    done < <(find "$MIGRATION_MARKER_STAGING" -mindepth 1 -maxdepth 1 -type f -print0)
    sync -f "$MIGRATION_MARKER_STAGING"
    mv -- "$MIGRATION_MARKER_STAGING" "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
    MIGRATION_MARKER_STAGING=""
  fi
fi
