# shellcheck shell=bash
# Hold boot enablement, quiesce services, and verify restored service state.

restore_upgrade_enablement() {
  local restored_target_state restored_singbox_state
  if [[ "$UPGRADE_WAS_ENABLED" == yes ]]; then
    systemctl enable vpn-gateway.target
  else
    systemctl disable vpn-gateway.target
  fi
  if [[ "$UPGRADE_SINGBOX_WAS_ENABLED" == yes ]]; then
    systemctl enable vpn-gateway-sing-box.service
  else
    systemctl disable vpn-gateway-sing-box.service
  fi
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  restored_target_state="$(query_upgrade_enablement vpn-gateway.target no)"
  if [[ "$UPGRADE_WAS_ENABLED" == yes ]]; then
    [[ "$restored_target_state" == enabled ]] \
      || die "Could not restore the target's enabled state."
  else
    [[ "$restored_target_state" == disabled ]] \
      || die "Could not restore the target's disabled state."
  fi
  restored_singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
  if [[ "$UPGRADE_SINGBOX_WAS_ENABLED" == yes ]]; then
    [[ "$restored_singbox_state" == enabled ]] \
      || die "Could not restore sing-box service enablement."
  else
    [[ "$restored_singbox_state" == disabled || "$restored_singbox_state" == static ]] \
      || die "Could not restore sing-box service disablement."
  fi
}

query_upgrade_enablement() {
  local unit_name="$1"
  local allow_static="$2"
  local allow_not_found="${3:-no}"
  local query_output query_status
  set +e
  query_output="$(systemctl is-enabled "$unit_name" 2>/dev/null)"
  query_status=$?
  set -e
  case "$query_output" in
    enabled)
      (( query_status == 0 )) \
        || die "systemd returned an inconsistent enabled state for $unit_name."
      ;;
    disabled)
      (( query_status != 0 )) \
        || die "systemd returned an inconsistent disabled state for $unit_name."
      ;;
    static)
      [[ "$allow_static" == yes ]] \
        || die "$unit_name is unexpectedly static; repair its unit installation before retrying."
      ;;
    not-found)
      [[ "$allow_not_found" == yes && "$query_status" -ne 0 ]] \
        || die "$unit_name unexpectedly has no installed unit."
      ;;
    *)
      die "Could not determine a supported enablement state for $unit_name (status $query_status, state ${query_output:-empty})."
      ;;
  esac
  printf '%s\n' "$query_output"
}

query_unit_active_state() {
  local unit_name="$1"
  local allow_not_found="${2:-no}"
  local query_output query_status
  set +e
  query_output="$(systemctl is-active "$unit_name" 2>/dev/null)"
  query_status=$?
  set -e
  case "$query_output" in
    active)
      (( query_status == 0 )) \
        || die "systemd returned an inconsistent active state for $unit_name."
      ;;
    inactive|failed)
      (( query_status != 0 )) \
        || die "systemd returned an inconsistent inactive state for $unit_name."
      ;;
    unknown)
      [[ "$allow_not_found" == yes && "$query_status" -ne 0 ]] \
        || die "$unit_name unexpectedly has no loaded unit."
      ;;
    *)
      die "Could not determine a stable active state for $unit_name (status $query_status, state ${query_output:-empty})."
      ;;
  esac
  printf '%s\n' "$query_output"
}

hold_upgrade_services_disabled() {
  local allow_not_found="${1:-no}"
  local target_state singbox_state unit_name enablement_link
  # The journal is already durable before this point. Holding both possible
  # boot entry points disabled prevents a reboot from starting a half-written
  # deployment; manual start for acceptance remains possible while disabled.
  # Remove the two canonical links explicitly as well: a power loss between
  # removing a unit file and restoring it can make systemctl report not-found
  # while a dangling enablement link is still waiting to become live again.
  for unit_name in vpn-gateway.target vpn-gateway-sing-box.service; do
    enablement_link="$SYSTEMD_ROOT/multi-user.target.wants/$unit_name"
    if path_is_present "$enablement_link"; then
      [[ -L "$enablement_link" && "$(stat -c '%u' -- "$enablement_link")" == 0 ]] \
        || die "Refusing unsafe upgrade enablement entry: $enablement_link"
      rm -f -- "$enablement_link"
    fi
  done
  target_state="$(query_upgrade_enablement vpn-gateway.target no "$allow_not_found")"
  if [[ "$target_state" == enabled ]]; then
    systemctl disable vpn-gateway.target >/dev/null 2>&1 \
      || die "Could not disable vpn-gateway.target before upgrade mutation."
    target_state="$(query_upgrade_enablement vpn-gateway.target no "$allow_not_found")"
  fi
  singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes "$allow_not_found")"
  if [[ "$singbox_state" == enabled ]]; then
    systemctl disable vpn-gateway-sing-box.service >/dev/null 2>&1 \
      || die "Could not disable vpn-gateway-sing-box.service before upgrade mutation."
    singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes "$allow_not_found")"
  fi
  [[ "$target_state" == disabled \
      || ( "$allow_not_found" == yes && "$target_state" == not-found ) ]] \
    || die "vpn-gateway.target remained enabled while preparing the upgrade."
  [[ "$singbox_state" == disabled || "$singbox_state" == static \
      || ( "$allow_not_found" == yes && "$singbox_state" == not-found ) ]] \
    || die "vpn-gateway-sing-box.service remained enabled while preparing the upgrade."
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
}

hold_migration_target_disabled() {
  local target_state
  target_state="$(query_upgrade_enablement vpn-gateway.target no yes)"
  if [[ "$target_state" == enabled ]]; then
    systemctl disable vpn-gateway.target >/dev/null 2>&1 \
      || die "Could not keep vpn-gateway.target disabled during legacy migration."
    target_state="$(query_upgrade_enablement vpn-gateway.target no yes)"
  fi
  [[ "$target_state" == disabled || "$target_state" == not-found ]] \
    || die "vpn-gateway.target is not safely disabled during legacy migration."
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
}

quiesce_upgrade_services_for_rollback() {
  local service_name
  local -a service_names=(
    vpn-gateway.target \
    vpn-gateway-controller.service \
    vpn-gateway-sing-box.service \
    vpn-gateway-subscription.service \
    vpn-gateway-admin.service
  )
  for service_name in "${service_names[@]}"; do
    # A power loss while deployment files are being restored can leave one of
    # these unit files absent. Missing is conclusively non-running and must not
    # prevent the durable journal from restoring the file on the next pass.
    stop_unit_if_active_strict "$service_name" yes
  done
  stop_unit_if_active_strict vpn-gateway-tunnel.service yes
}

restart_and_verify_restored_upgrade() {
  local service_name active_state
  local -a service_names=(
    vpn-gateway.target
    vpn-gateway-controller.service
    vpn-gateway-sing-box.service
    vpn-gateway-subscription.service
    vpn-gateway-admin.service
  )
  [[ "$UPGRADE_WAS_ACTIVE" == yes ]] || return 0
  systemctl start vpn-gateway.target \
    || die "The previous deployment was restored but could not be restarted."
  if [[ "$UPGRADE_HAD_UNIT_TUNNEL" == yes ]]; then
    service_names+=(vpn-gateway-tunnel.service)
  fi
  for service_name in "${service_names[@]}"; do
    active_state="$(query_unit_active_state "$service_name")"
    [[ "$active_state" == active ]] \
      || die "The previous deployment restart left $service_name inactive; rollback journal retained."
  done
}

stop_unit_if_active_strict() {
  local unit_name="$1"
  local allow_not_found="${2:-no}"
  local active_state
  active_state="$(query_unit_active_state "$unit_name" "$allow_not_found")"
  if [[ "$active_state" == active ]]; then
    systemctl stop "$unit_name"
  fi
  active_state="$(query_unit_active_state "$unit_name" "$allow_not_found")"
  [[ "$active_state" == inactive || "$active_state" == failed || "$active_state" == unknown ]] \
    || die "$unit_name did not reach a conclusively stopped state."
}

restore_legacy_service_state() {
  local unit_name="$1"
  local was_active="$2"
  local was_enabled="$3"
  local active_state enablement_state
  if [[ "$was_enabled" == yes ]]; then
    systemctl enable "$unit_name"
  fi
  if [[ "$was_active" == yes ]]; then
    systemctl start "$unit_name"
  else
    stop_unit_if_active_strict "$unit_name"
  fi
  active_state="$(query_unit_active_state "$unit_name")"
  enablement_state="$(query_upgrade_enablement "$unit_name" yes yes)"
  if [[ "$was_active" == yes ]]; then
    [[ "$active_state" == active ]] \
      || die "$unit_name was active before migration but could not be restored."
  else
    [[ "$active_state" == inactive || "$active_state" == failed ]] \
      || die "$unit_name was inactive before migration but became active."
  fi
  if [[ "$was_enabled" == yes ]]; then
    [[ "$enablement_state" == enabled ]] \
      || die "$unit_name was enabled before migration but could not be restored."
  else
    [[ "$enablement_state" != enabled ]] \
      || die "$unit_name was disabled before migration but became enabled."
  fi
}
